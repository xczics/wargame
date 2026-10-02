/**
 * Battle: five lanes a side, lane i against lane i (docs/design/gameplay.md §3).
 *
 * - Each lane holds one unit family (content registers them with `defineFamily`, and the
 *   counters between them with `addCounter`); troops of families not registered here do
 *   not fight.
 * - Defenders set their formation per settlement (only the family of each lane: every
 *   garrisoned unit fights, split evenly over the lanes of its family). Until they do, a
 *   default derived from the settlement id is used, so it stays the same between reads.
 * - Attackers choose lanes and the units in them when they march out (a send option of
 *   the armies plugin), fixed until they arrive.
 * - Numbers can be raised by modifiers from any plugin (`addModifier`): a flat amount per
 *   lane and a percentage, scoped to a side / family / tier. Walls, research and heroes all
 *   come in this way; the battle plugin knows none of them.
 * - Auxiliary units (medics, supply trains...) are simply units of a family not registered
 *   here: they march and garrison but stand in no lane. Casualty hooks (`addCasualtyHook`)
 *   can change losses at every step of the formula — and give auxiliaries a part in them.
 */
import { csvRules, definePlugin, type EngineApi, GameError, numberInRange, PluginError, type ReadApi, seededRandom } from '../../kernel';
import type { BattleDetail, BattleFormationInfo, BattleGrade, LaneSideReport } from '../../shared/api';
import type { LanesInputData } from '../../shared/ui';
import type { Settlement } from '../settlements';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

/** Design numbers (./data/rules.csv); GM overrides go on top. */
const RULES = csvRules(rulesCsv);

export const LANES = 5;

export interface FamilyDef {
	id: string;
	name: string;
	icon?: string;
}

/** One lane of an attacking army: its family and how many of each unit are in it. */
export interface Lane {
	family: string;
	units: Record<string, number>;
}

/** Who is fighting on one side. */
export interface BattleSide {
	role: 'attacker' | 'defender';
	/** null for NPCs. */
	playerId: string | null;
	/** The settlement defended (defender) or marched from (attacker), if any. */
	settlement: Settlement | null;
	/** The marching army, for the attacker. */
	armyId?: string;
}

/** `loot` and `carry` are for the attacker's plunder (read by whoever resolves it, e.g. pvp). */
export type BattleStat = 'attack' | 'defense' | 'hp' | 'counter' | 'casualty' | 'loot' | 'carry';

/**
 * A change to a battle number. `flat` is added to every lane (e.g. wall defence);
 * `percent` values of one stat are added together, then multiply. `family` / `tier` limit
 * it to those units (a tier-limited percent applies to that tier's share of the lane).
 */
export interface Modifier {
	source: string;
	stat: BattleStat;
	flat?: number;
	percent?: number;
	family?: string;
	tier?: number;
}

/** What a casualty hook sees: one side, with all its units (auxiliaries included). */
export interface CasualtyContext {
	side: BattleSide;
	units: Record<string, number>;
}

/**
 * Changes losses at the steps of §3.8 (all optional; return null for "no change"):
 * `damage` per lane (step 2, after the hp cap), `spread` per lane deaths by unit (step 3),
 * `total` deaths summed over lanes and the casualty factor (step 4), `final` the rounded
 * losses (step 5; may add auxiliary units). Each change is listed in the report. Read only.
 */
export interface CasualtyHook {
	source: string;
	damage?(api: EngineApi, c: CasualtyContext & { lane: number; damage: number }): Promise<number | null>;
	spread?(api: EngineApi, c: CasualtyContext & { lane: number; deaths: Record<string, number> }): Promise<Record<string, number> | null>;
	total?(
		api: EngineApi,
		c: CasualtyContext & { deaths: Record<string, number>; factor: number },
	): Promise<{ deaths?: Record<string, number>; factor?: number } | null>;
	final?(api: EngineApi, c: CasualtyContext & { losses: Record<string, number> }): Promise<Record<string, number> | null>;
}

/** Modifiers for one side of a battle (read only). */
export type ModifierProvider = (
	api: EngineApi,
	side: BattleSide,
	battle: { attacker: BattleSide; defender: BattleSide },
) => Promise<Modifier[]>;

export interface BattleService {
	defineFamily(def: FamilyDef): void;
	families(): readonly FamilyDef[];
	/** `strong` beats `weak` when they meet in a lane. */
	addCounter(strong: string, weak: string): void;
	counters(strong: string, weak: string): boolean;
	addModifier(provider: ModifierProvider): void;
	addCasualtyHook(hook: CasualtyHook): void;
	modifiers(api: EngineApi, side: BattleSide, battle: { attacker: BattleSide; defender: BattleSide }): Promise<Modifier[]>;
	/**
	 * A building where players set the defence formation (e.g. the wall): the formation form
	 * shows up on its entry. Without one, settlements defend in their default formation.
	 */
	addFormationSite(buildingId: string): void;
	/** A settlement's defence formation: the saved one, or its default (not saved). */
	formation(api: ReadApi, settlementId: string): Promise<string[]>;
	/** Save the default formation if the settlement has none yet (call before a battle is decided on it). */
	fixFormation(api: EngineApi, settlementId: string): Promise<string[]>;
	/** The family of a unit, if it fights in lanes. */
	familyOf(unit: string): string | undefined;
	/** A defender's lanes: every fighting unit split evenly over the lanes of its family (units without one stay out). */
	defenderLanes(units: Record<string, number>, formation: string[]): Lane[];
	/** The lanes an army marched out with (its `formation` send option), or the default split. */
	attackerLanes(options: Record<string, unknown>, units: Record<string, number>): Lane[];
	/** A random formation for defenders without one (NPCs), fixed by `seed` so retries agree. */
	randomFormation(seed: string): string[];
	/** Promotions earned by a side that had `units` and lost `lost` (§2.6); `fight` calls it for you. */
	/** `cost` scales the quota a promotion needs (stat `battle.promotionCost`, 1 = as designed). */
	promotions(units: Record<string, number>, lost: Record<string, number>, cost?: number): Promotion[];
	/**
	 * Fight it out (docs/design/gameplay.md §3.5-3.8). Callers apply the losses; `onFought` listeners hear of
	 * the result in the same command (their writes commit with it).
	 */
	fight(
		api: EngineApi,
		/** `units`: everything the side has there, auxiliaries included (default: what is in the lanes). */
		input: {
			attacker: { side: BattleSide; lanes: Lane[]; units?: Record<string, number> };
			defender: { side: BattleSide; lanes: Lane[]; units?: Record<string, number> };
		},
	): Promise<BattleResult>;
	/** Told after every `fight`, e.g. to injure the heroes of a routed side. May write (same commit as the battle). */
	onFought(listener: (api: EngineApi, battle: { attacker: BattleSide; defender: BattleSide }, result: BattleResult) => Promise<void>): void;
}

/** Survivors moving up a tier after the battle. */
export interface Promotion {
	from: string;
	to: string;
	count: number;
}

export interface BattleResult {
	/** The attacker won at least 3 lanes. */
	victory: boolean;
	losses: { attacker: Record<string, number>; defender: Record<string, number> };
	/** Battle promotions (§2.6), for players' sides that were not routed. Callers apply them after the losses. */
	promotions: { attacker: Promotion[]; defender: Promotion[] };
	/** Totals over the lanes: the attacker's attack and the defender's defence. */
	attack: number;
	defense: number;
	detail: BattleDetail;
}

/** Grade of a side that won `wins` of the 5 lanes. */
export const gradeOf = (wins: number): BattleGrade =>
	wins >= 5 ? 'crushing' : wins === 4 ? 'victory' : wins === 3 ? 'narrow' : wins === 2 ? 'narrow-defeat' : 'routed';

declare module '../../kernel' {
	interface ServiceMap {
		battle: BattleService;
	}
}

/** Five lanes with every family at least once (when there are at most five), in random order. */
export function randomLanes(families: string[], random: () => number): string[] {
	if (!families.length) return [];
	const lanes = families.slice(0, LANES);
	while (lanes.length < LANES) lanes.push(families[Math.floor(random() * families.length)]);
	for (let i = lanes.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[lanes[i], lanes[j]] = [lanes[j], lanes[i]];
	}
	return lanes;
}

export default definePlugin({
	id: 'battle',
	version: '0.1.0',
	description: 'Five-lane battles: formations, counters, modifiers',
	dependsOn: ['troops', 'settlements', 'armies', 'stats', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv);
		const troops = ctx.services.get('troops');
		const stats = ctx.services.get('stats');
		// Quota a promotion needs, relative to the design (e.g. 0.9 after a military reform).
		stats.define({ id: 'battle.promotionCost', description: 'promotion cost', base: () => 1, min: 0.01 });
		const settlements = ctx.services.get('settlements');
		const armies = ctx.services.get('armies');
		const families = new Map<string, FamilyDef>();
		const counters = new Set<string>();
		const providers: ModifierProvider[] = [];
		const casualtyHooks: CasualtyHook[] = [];

		const loadFormation = (api: ReadApi, settlementId: string) =>
			api.memo(`battle:formation:${settlementId}`, async () => {
				const row = await api.db
					.prepare('SELECT lanes FROM battle_formations WHERE settlement_id = ?')
					.bind(settlementId)
					.first<{ lanes: string }>();
				return { lanes: row ? (JSON.parse(row.lanes) as string[]) : null };
			});
		const defaultFormation = (settlementId: string) => randomLanes([...families.keys()], seededRandom(`formation:${settlementId}`));
		const saveFormation = async (api: EngineApi, settlementId: string, lanes: string[]) => {
			(await loadFormation(api, settlementId)).lanes = lanes;
			api.write(
				api.db
					.prepare(
						'INSERT INTO battle_formations (settlement_id, lanes) VALUES (?, ?) ON CONFLICT (settlement_id) DO UPDATE SET lanes = excluded.lanes',
					)
					.bind(settlementId, JSON.stringify(lanes)),
			);
		};

		/** Lanes must name registered families, and every family needs a lane (when there are at most five). */
		function checkLanes(lanes: unknown): string[] {
			if (!Array.isArray(lanes) || lanes.length !== LANES)
				throw new GameError('bad_payload', `Give a family for each of the ${LANES} lanes`);
			for (const f of lanes)
				if (typeof f !== 'string' || !families.has(f)) throw new GameError('bad_payload', `Unknown unit family "${f}"`);
			if (families.size <= LANES)
				for (const f of families.values())
					if (!lanes.includes(f.id)) throw new GameError('bad_formation', `Every unit family needs a lane: ${f.name}`);
			return lanes as string[];
		}

		const counterFactor = ctx.config.define('counterFactor', {
			description: 'When a lane counters the other: the attacker’s attack, or the defender’s defence, is multiplied by this.',
			default: () => RULES.counterFactor as number,
			parse: numberInRange(1, 1000),
		});
		const CASUALTY = RULES.casualty as Record<'crushing' | 'victory' | 'narrow' | 'narrow-defeat' | 'routed', number>;
		const casualtyFactors = ctx.config.define('casualtyFactors', {
			description: 'Each side’s losses are multiplied by the factor of its result (partial overrides allowed).',
			default: () => CASUALTY,
			parse(raw) {
				if (typeof raw !== 'object' || raw === null) throw new GameError('bad_config', 'Expected { grade: factor }');
				const out: Record<string, number> = { ...CASUALTY };
				for (const [k, v] of Object.entries(raw)) {
					if (!(k in CASUALTY)) throw new GameError('bad_config', `Unknown result "${k}" (known: ${Object.keys(CASUALTY).join(', ')})`);
					out[k] = numberInRange(0, 100)(v);
				}
				return out as typeof CASUALTY;
			},
		});

		/** Totals of one side of one lane after modifiers (and the counter, when it applies). */
		function laneNumbers(api: ReadApi, lane: Lane, mods: Modifier[]) {
			const applies = (m: Modifier) => !m.family || m.family === lane.family;
			const sum = (stat: BattleStat) => {
				const own = mods.filter((m) => m.stat === stat && applies(m));
				let total = 0;
				for (const [u, n] of Object.entries(lane.units)) {
					const tier = troops.get(u)?.tier;
					const tierPct = own.filter((m) => m.tier !== undefined && m.tier === tier).reduce((a, m) => a + (m.percent ?? 0), 0);
					total += (troops.stats(api, u)[stat as 'attack' | 'defense' | 'hp'] ?? 0) * n * (1 + tierPct / 100);
				}
				const general = own.filter((m) => m.tier === undefined);
				const flat = general.reduce((a, m) => a + (m.flat ?? 0), 0);
				const pct = general.reduce((a, m) => a + (m.percent ?? 0), 0);
				return {
					total: Math.max(0, (total + flat) * (1 + pct / 100)),
					// The part the troops bring (counters multiply only this).
					troops: Math.max(0, total * (1 + pct / 100)),
					multiplier: 1 + pct / 100,
					flat: Math.max(0, flat * (1 + pct / 100)),
				};
			};
			const empty = !Object.values(lane.units).some((n) => n > 0);
			const attack = sum('attack');
			const defense = sum('defense');
			const hp = sum('hp');
			// An empty lane has no attack and no one to lose; walls and other flat defence still hold it.
			// Flat hp (e.g. siege defences) is a buffer: it takes damage before the troops do.
			return {
				attack: empty ? 0 : attack.total,
				defense: defense.total,
				hp: empty ? 0 : hp.total,
				hpMultiplier: hp.multiplier,
				hpBuffer: empty ? 0 : hp.flat,
				attackTroops: empty ? 0 : attack.troops,
				defenseTroops: defense.troops,
			};
		}

		/** The unit one tier up in the same family, if any. */
		const higherTier = (unit: string) => {
			const def = troops.get(unit);
			if (!def?.family || !def.tier) return undefined;
			return troops.list().find((d) => d.family === def.family && d.tier === def.tier! + 1);
		};

		/**
		 * Battle promotion (§2.6), tier by tier from the lowest: a tier's quota is its dead plus
		 * what was left over below (divided by the tier). Each promotion of a tier-N survivor
		 * — one who was tier N when the battle began — costs N of the quota, same family first,
		 * then any family 1:1. Leftovers pass up divided by N+1; the top tier's are lost.
		 */
		function promotions(units: Record<string, number>, lost: Record<string, number>, cost = 1): Promotion[] {
			const out: Promotion[] = [];
			const byTier = new Map<number, { unit: string; family: string; quota: number; survivors: number }[]>();
			for (const [u, n] of Object.entries(units)) {
				const def = troops.get(u);
				if (!def?.family || !def.tier || n <= 0) continue;
				const list = byTier.get(def.tier) ?? [];
				list.push({ unit: u, family: def.family, quota: lost[u] ?? 0, survivors: n - (lost[u] ?? 0) });
				byTier.set(def.tier, list);
			}
			const carried = new Map<string, number>(); // family -> quota carried up to the current tier
			const top = Math.max(0, ...byTier.keys());
			for (let tier = 1; tier <= top; tier++) {
				const groups = byTier.get(tier) ?? [];
				// Quota per family at this tier: its dead here plus what came up from below.
				const quota = new Map<string, number>();
				for (const g of groups) quota.set(g.family, (quota.get(g.family) ?? 0) + g.quota);
				for (const [family, q] of carried) quota.set(family, (quota.get(family) ?? 0) + q);
				carried.clear();
				const promote = (g: (typeof groups)[number], family: string) => {
					const next = higherTier(g.unit);
					if (!next) return;
					const price = tier * Math.max(0.01, cost);
					const count = Math.min(g.survivors, Math.floor((quota.get(family) ?? 0) / price + 1e-9));
					if (count <= 0) return;
					g.survivors -= count;
					quota.set(family, (quota.get(family) ?? 0) - count * price);
					const existing = out.find((p) => p.from === g.unit);
					if (existing) existing.count += count;
					else out.push({ from: g.unit, to: next.id, count });
				};
				for (const g of groups) promote(g, g.family); // same family first
				for (const family of [...quota.keys()]) for (const g of groups) promote(g, family); // then across families, 1:1
				for (const [family, q] of quota) if (q > 0) carried.set(family, q / (tier + 1));
			}
			return out;
		}

		/**
		 * Spread `damage` over a lane's units in proportion to headcount, lowest tier first:
		 * a tier dies up to its whole number; damage it cannot absorb passes on to the higher
		 * tiers, again by headcount. Returns fractional deaths per unit.
		 */
		function spread(api: ReadApi, lane: Lane, damage: number, hpMultiplier: number) {
			const groups = Object.entries(lane.units)
				.filter(([, n]) => n > 0)
				.map(([u, n]) => ({ u, n, tier: troops.get(u)?.tier ?? 1, hp: Math.max(1e-9, troops.stats(api, u).hp * hpMultiplier) }))
				.sort((a, b) => a.tier - b.tier);
			const heads = groups.reduce((a, g) => a + g.n, 0);
			const share = groups.map((g) => (damage * g.n) / Math.max(1, heads));
			const deaths: Record<string, number> = {};
			for (let i = 0; i < groups.length; i++) {
				const g = groups[i];
				const dead = Math.min(g.n, share[i] / g.hp);
				deaths[g.u] = (deaths[g.u] ?? 0) + dead;
				const overflow = share[i] - dead * g.hp;
				if (overflow <= 1e-9) continue;
				const rest = groups.slice(i + 1);
				const restHeads = rest.reduce((a, r) => a + r.n, 0);
				rest.forEach((r, j) => (share[i + 1 + j] += (overflow * r.n) / Math.max(1, restHeads)));
			}
			return deaths;
		}

		const formationSites = new Set<string>();
		const foughtListeners: ((
			api: EngineApi,
			battle: { attacker: BattleSide; defender: BattleSide },
			result: BattleResult,
		) => Promise<void>)[] = [];
		const service: BattleService = {
			addFormationSite: (id) => void formationSites.add(id),
			defineFamily(def) {
				if (families.has(def.id)) throw new PluginError(`Family "${def.id}" defined twice`);
				families.set(def.id, def);
			},
			families: () => [...families.values()],
			addCounter: (strong, weak) => void counters.add(`${strong}>${weak}`),
			counters: (strong, weak) => counters.has(`${strong}>${weak}`),
			addModifier: (p) => void providers.push(p),
			addCasualtyHook: (h) => void casualtyHooks.push(h),
			async modifiers(api, side, battle) {
				return (await Promise.all(providers.map((p) => p(api, side, battle)))).flat();
			},
			async formation(api, settlementId) {
				return (await loadFormation(api, settlementId)).lanes ?? defaultFormation(settlementId);
			},
			async fixFormation(api, settlementId) {
				const stored = (await loadFormation(api, settlementId)).lanes;
				if (stored) return stored;
				const lanes = defaultFormation(settlementId);
				await saveFormation(api, settlementId, lanes);
				return lanes;
			},
			familyOf: (unit) => {
				const f = troops.get(unit)?.family;
				return f && families.has(f) ? f : undefined;
			},
			defenderLanes(units, formation) {
				const fighting = Object.fromEntries(Object.entries(units).filter(([u, n]) => n > 0 && service.familyOf(u)));
				const lanes: Lane[] = formation.map((family) => ({ family, units: {} }));
				for (const [u, n] of Object.entries(fighting)) {
					const own = lanes.filter((l) => l.family === service.familyOf(u));
					// A family without a lane (e.g. added after the formation was set) stays out of the fight.
					own.forEach((l, i) => {
						const c = Math.floor(n / own.length) + (i < n % own.length ? 1 : 0);
						if (c) l.units[u] = c;
					});
				}
				return lanes;
			},
			attackerLanes(options, units) {
				if (Array.isArray(options.formation)) return options.formation as Lane[];
				const fighting = Object.fromEntries(Object.entries(units).filter(([u, n]) => n > 0 && service.familyOf(u)));
				const present = [...new Set(Object.keys(fighting).map((u) => service.familyOf(u)!))];
				const all = [...families.keys()];
				return splitOverLanes(
					Array.from({ length: LANES }, (_, i) => present[i % Math.max(1, present.length)] ?? all[0]),
					fighting,
				);
			},
			randomFormation: (seed) => randomLanes([...families.keys()], seededRandom(seed)),
			promotions,

			async fight(api, input) {
				const { attacker, defender } = input;
				const battle = { attacker: attacker.side, defender: defender.side };
				const mods = {
					attacker: await service.modifiers(api, attacker.side, battle),
					defender: await service.modifiers(api, defender.side, battle),
				};
				const pct = (list: Modifier[], stat: BattleStat) => list.filter((m) => m.stat === stat).reduce((a, m) => a + (m.percent ?? 0), 0);
				const lanes: BattleDetail['lanes'] = [];
				const deaths = { attacker: {} as Record<string, number>, defender: {} as Record<string, number> };
				const adjustments: BattleDetail['adjustments'] = [];
				// Units present per side, to cap the rounded losses.
				const count = (ls: Lane[]) => {
					const out: Record<string, number> = {};
					for (const l of ls) for (const [u, n] of Object.entries(l.units)) out[u] = (out[u] ?? 0) + n;
					return out;
				};
				const all = { attacker: attacker.units ?? count(attacker.lanes), defender: defender.units ?? count(defender.lanes) };
				const ctxOf = (role: 'attacker' | 'defender'): CasualtyContext => ({ side: input[role].side, units: all[role] });
				/** Run one step of every hook; the last non-null answer of each hook is kept and noted. */
				async function step<T>(
					role: 'attacker' | 'defender',
					stage: string,
					value: T,
					run: (h: CasualtyHook, v: T) => Promise<T | null> | undefined,
				) {
					for (const h of casualtyHooks) {
						const next = await run(h, value);
						if (next !== null && next !== undefined) {
							value = next;
							adjustments.push({ side: role, stage, source: h.source });
						}
					}
					return value;
				}
				let attackTotal = 0;
				let defenseTotal = 0;
				for (let i = 0; i < LANES; i++) {
					const aLane = attacker.lanes[i] ?? { family: '', units: {} };
					const dLane = defender.lanes[i] ?? { family: '', units: {} };
					const a = laneNumbers(api, aLane, mods.attacker);
					const d = laneNumbers(api, dLane, mods.defender);
					// Counters only raise the attacker's attack or the defender's defence, and only the part
					// the troops bring: walls, siege defences and other flat bonuses are not multiplied.
					const aCounters = service.counters(aLane.family, dLane.family);
					const dCounters = service.counters(dLane.family, aLane.family);
					if (aCounters) a.attack += a.attackTroops * (counterFactor.get(api) * (1 + pct(mods.attacker, 'counter') / 100) - 1);
					if (dCounters) d.defense += d.defenseTroops * (counterFactor.get(api) * (1 + pct(mods.defender, 'counter') / 100) - 1);
					attackTotal += a.attack;
					defenseTotal += d.defense;
					// Damage beyond a lane's hp is lost; either side only suffers what gets through its defence.
					const lane = i;
					const toDefender = await step('defender', 'damage', Math.min(d.hp, Math.max(0, a.attack - d.defense)), (h, damage) =>
						h.damage?.(api, { ...ctxOf('defender'), lane, damage }),
					);
					const toAttacker = await step('attacker', 'damage', Math.min(a.hp, Math.max(0, d.attack - a.defense)), (h, damage) =>
						h.damage?.(api, { ...ctxOf('attacker'), lane, damage }),
					);
					const dDead = await step(
						'defender',
						'spread',
						spread(api, dLane, Math.max(0, toDefender - d.hpBuffer), d.hpMultiplier),
						(h, dead) => h.spread?.(api, { ...ctxOf('defender'), lane, deaths: dead }),
					);
					const aDead = await step(
						'attacker',
						'spread',
						spread(api, aLane, Math.max(0, toAttacker - a.hpBuffer), a.hpMultiplier),
						(h, dead) => h.spread?.(api, { ...ctxOf('attacker'), lane, deaths: dead }),
					);
					for (const [u, n] of Object.entries(dDead)) deaths.defender[u] = (deaths.defender[u] ?? 0) + n;
					for (const [u, n] of Object.entries(aDead)) deaths.attacker[u] = (deaths.attacker[u] ?? 0) + n;
					const side = (
						lane: Lane,
						x: { attack: number; defense: number; hp: number },
						counters: boolean,
						dead: Record<string, number>,
					): LaneSideReport => ({
						family: lane.family,
						units: lane.units,
						attack: x.attack,
						defense: x.defense,
						hp: x.hp,
						counters,
						lost: Object.fromEntries(Object.entries(dead).map(([u, n]) => [u, Math.round(n * 100) / 100])),
					});
					lanes.push({
						attacker: side(aLane, a, aCounters, aDead),
						defender: side(dLane, d, dCounters, dDead),
						// A tie goes to the defender.
						winner: a.attack > d.defense ? 'attacker' : 'defender',
					});
				}
				const wins = { attacker: lanes.filter((l) => l.winner === 'attacker').length, defender: 0 };
				wins.defender = LANES - wins.attacker;
				const grade = { attacker: gradeOf(wins.attacker), defender: gradeOf(wins.defender) };
				const factors = casualtyFactors.get(api);
				// Casualty modifiers for one family (e.g. a formation that shields infantry) apply to
				// that family's losses only; the others to the whole side's factor.
				const general = (list: Modifier[]) => list.filter((m) => !m.family);
				const casualtyFactor = {
					attacker: Math.max(0, factors[grade.attacker] * (1 + pct(general(mods.attacker), 'casualty') / 100)),
					defender: Math.max(0, factors[grade.defender] * (1 + pct(general(mods.defender), 'casualty') / 100)),
				};
				const familyCasualty = (role: 'attacker' | 'defender', unit: string) => {
					const family = service.familyOf(unit);
					const own = mods[role].filter((m) => m.stat === 'casualty' && m.family && m.family === family);
					return Math.max(0, 1 + own.reduce((a, m) => a + (m.percent ?? 0), 0) / 100);
				};
				const losses = { attacker: {} as Record<string, number>, defender: {} as Record<string, number> };
				for (const role of ['attacker', 'defender'] as const) {
					const totals = await step(role, 'total', { deaths: deaths[role], factor: casualtyFactor[role] }, async (h, t) => {
						const r = await h.total?.(api, { ...ctxOf(role), deaths: t.deaths, factor: t.factor });
						return r ? { deaths: r.deaths ?? t.deaths, factor: r.factor ?? t.factor } : null;
					});
					casualtyFactor[role] = totals.factor;
					const rounded = Object.fromEntries(
						Object.entries(totals.deaths)
							.map(([u, n]) => [u, Math.min(all[role][u] ?? 0, Math.round(n * totals.factor * familyCasualty(role, u)))] as const)
							.filter(([, n]) => n > 0),
					);
					const final = await step(role, 'final', rounded, (h, l) => h.final?.(api, { ...ctxOf(role), losses: l }));
					// Whatever the hooks did, nobody loses more units than they have.
					losses[role] = Object.fromEntries(
						Object.entries(final)
							.map(([u, n]) => [u, Math.max(0, Math.min(all[role][u] ?? 0, Math.round(n)))] as const)
							.filter(([, n]) => n > 0),
					);
				}
				const view = (list: Modifier[]) => list.map(({ source, stat, flat, percent }) => ({ source, stat, flat, percent }));
				// Routed sides and NPCs do not promote.
				const costOf = async (role: 'attacker' | 'defender') => {
					const id = input[role].side.playerId;
					return id ? stats.get(api, 'battle.promotionCost', `player:${id}`) : 1;
				};
				const cost = { attacker: await costOf('attacker'), defender: await costOf('defender') };
				const promoted = (role: 'attacker' | 'defender', lanes: Lane[]) =>
					grade[role] === 'routed' || !input[role].side.playerId ? [] : promotions(count(lanes), losses[role], cost[role]);
				const result: BattleResult = {
					victory: wins.attacker >= 3,
					losses,
					promotions: { attacker: promoted('attacker', attacker.lanes), defender: promoted('defender', defender.lanes) },
					attack: attackTotal,
					defense: defenseTotal,
					detail: {
						lanes,
						wins,
						grade,
						casualtyFactor,
						modifiers: { attacker: view(mods.attacker), defender: view(mods.defender) },
						adjustments,
					},
				};
				for (const listener of foughtListeners) await listener(api, battle, result);
				return result;
			},
			onFought: (listener) => void foughtListeners.push(listener),
		};
		ctx.services.provide('battle', service);

		/* ----- defence formation -------------------------------------------------------- */

		const laneFields = Array.from({ length: LANES }, (_, i) => ({
			name: `lane${i + 1}`,
			label: `Lane ${i + 1}`,
			type: 'select' as const,
			required: true,
		}));
		const familyOptions = () => [...families.values()].map((f) => ({ value: f.id, label: f.name }));

		ctx.commands.add<{ settlement: string; lanes: string[] }>({
			type: 'battle.setFormation',
			description: 'Choose the unit family of each defence lane. Payload: { "settlement": "<id>", "lanes": ["infantry", "archer", ...] }',
			form: {
				title: 'Defence formation',
				description: 'All troops here defend: each family is split evenly over its lanes.',
				placement: 'building',
				fields: [{ name: 'settlement', label: 'settlement', type: 'hidden' }, ...laneFields],
				submitLabel: 'Save formation',
				async prepare(api, params) {
					// On the entry of a formation site (e.g. the wall) of the settlement.
					if (!params.type || !formationSites.has(params.type)) return false;
					const s = await settlements.resolve(api, params);
					if (!s || s.ownerId !== api.playerId || !families.size) return false;
					const lanes = await service.formation(api, s.id);
					const options = familyOptions();
					return {
						defaults: { settlement: s.id, ...Object.fromEntries(lanes.map((f, i) => [`lane${i + 1}`, f])) },
						options: Object.fromEntries(laneFields.map((f) => [f.name, options])),
					};
				},
			},
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.settlement !== 'string') throw new GameError('bad_payload', 'settlement is required');
				const lanes = Array.isArray(p.lanes) ? p.lanes : Array.from({ length: LANES }, (_, i) => p[`lane${i + 1}`]);
				return { settlement: p.settlement, lanes: checkLanes(lanes) };
			},
			async execute(api, { settlement, lanes }) {
				await settlements.requireOwned(api, settlement);
				await saveFormation(api, settlement, lanes);
			},
		});

		ctx.views.add({
			id: 'battle.formation',
			async compute(api, params): Promise<BattleFormationInfo | null> {
				const s = await settlements.resolve(api, params);
				if (!s) return null;
				return { settlement: s.id, lanes: await service.formation(api, s.id), saved: !!(await loadFormation(api, s.id)).lanes };
			},
		});
		ctx.meta.add('battleFamilies', () => service.families());

		/* ----- attack formation: chosen when an army marches out ------------------------ */

		/**
		 * `formation` = 5 lanes of { family, units }, which must hold exactly the fighting units sent
		 * (units of no family — support units — march outside the lanes). The form's editor (the generic
		 * field widget "ui.lanes-input") sends it along with the units. Older forms: `lane1`..`lane5`
		 * families, each unit type split evenly over the lanes of its family. Neither: the families
		 * present, cycled over the lanes.
		 */
		armies.addSendOption({
			key: 'formation',
			missions: ['attack'],
			choosesUnits: true,
			async fields(api) {
				if (!families.size) return [];
				// What each settlement of the player could send, for the editor's "at most" hints.
				const garrisons: Record<string, Record<string, number>> = {};
				const present = new Set<string>();
				for (const s of await settlements.mine(api, api.playerId)) {
					const g = Object.fromEntries([...(await troops.garrison(api, s.id))].filter(([, n]) => n > 0));
					if (!Object.keys(g).length) continue;
					garrisons[s.id] = g;
					for (const u of Object.keys(g)) present.add(u);
				}
				const options = troops
					.list()
					.filter((u) => present.has(u.id))
					.map((u) => ({ id: u.id, label: { text: u.name }, group: service.familyOf(u.id) ?? null, order: u.tier ?? 1 }));
				// The generic lanes editor: lanes of a family, support units in the extra box, the origin's garrison as the pool.
				const data: LanesInputData = {
					title: { text: 'Formation' },
					lanes: LANES,
					laneLabel: { text: 'Lane {0}' },
					groups: service.families().map((f) => ({ id: f.id, label: { text: '{0} {1}', vars: { 0: f.icon ?? '', 1: f.name } } })),
					options,
					poolField: 'from',
					pools: garrisons,
					output: { lanes: 'formation', group: 'family', counts: 'units', total: 'units' },
					extra: { title: { text: 'Support units' }, note: { text: 'march along outside the lanes' } },
					emptyLane: { text: 'No such troops here: this lane stays empty.' },
					summary: { text: '{0} in the lanes, {1} support units' },
				};
				return [{ name: 'formation', label: 'Formation', type: 'widget' as const, widget: 'ui.lanes-input', data }];
			},
			async parse(_api, raw, { units }) {
				if (!families.size) return undefined;
				const fighting = Object.fromEntries(Object.entries(units).filter(([u]) => service.familyOf(u)));
				if (Array.isArray(raw.formation)) return explicitLanes(raw.formation, fighting);
				const chosen = Array.from({ length: LANES }, (_, i) => raw[`lane${i + 1}`]);
				const present = [...new Set(Object.keys(fighting).map((u) => service.familyOf(u)!))];
				const lanes: string[] = chosen.some((f) => typeof f === 'string' && f)
					? chosen.map((f) => {
							if (typeof f !== 'string' || !families.has(f)) throw new GameError('bad_payload', 'Choose a family for every lane');
							return f;
						})
					: Array.from({ length: LANES }, (_, i) => present[i % Math.max(1, present.length)] ?? [...families.keys()][0]);
				return splitOverLanes(lanes, fighting);
			},
		});

		function explicitLanes(raw: unknown[], units: Record<string, number>): Lane[] {
			if (raw.length !== LANES) throw new GameError('bad_payload', `A formation has ${LANES} lanes`);
			const placed: Record<string, number> = {};
			const lanes = raw.map((l) => {
				const lane = (l ?? {}) as { family?: unknown; units?: unknown };
				if (typeof lane.family !== 'string' || !families.has(lane.family))
					throw new GameError('bad_payload', 'Each lane needs a known family');
				const out: Record<string, number> = {};
				for (const [u, n] of Object.entries((lane.units ?? {}) as Record<string, unknown>)) {
					const c = Number(n);
					if (!Number.isInteger(c) || c < 0) throw new GameError('bad_payload', 'Lane unit counts must be non-negative integers');
					if (!c) continue;
					if (service.familyOf(u) !== lane.family)
						throw new GameError('bad_formation', `${troops.get(u)?.name ?? u} cannot stand in a ${families.get(lane.family)!.name} lane`);
					out[u] = c;
					placed[u] = (placed[u] ?? 0) + c;
				}
				return { family: lane.family, units: out };
			});
			for (const u of new Set([...Object.keys(units), ...Object.keys(placed)]))
				if ((units[u] ?? 0) !== (placed[u] ?? 0)) throw new GameError('bad_formation', 'The lanes must hold exactly the units sent');
			return lanes;
		}

		/** Every unit type split evenly over the lanes of its family; the remainder goes to the first lanes. */
		function splitOverLanes(families_: string[], units: Record<string, number>): Lane[] {
			const lanes: Lane[] = families_.map((family) => ({ family, units: {} }));
			for (const [u, n] of Object.entries(units)) {
				const family = service.familyOf(u)!;
				const own = lanes.filter((l) => l.family === family);
				if (!own.length) throw new GameError('bad_formation', `No lane for ${families.get(family)!.name}`);
				own.forEach((l, i) => {
					const c = Math.floor(n / own.length) + (i < n % own.length ? 1 : 0);
					if (c) l.units[u] = c;
				});
			}
			return lanes;
		}
	},
});
