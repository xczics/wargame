/**
 * Bandits (docs/design/gameplay.md §12.2-12.4): every player has a timeline (entity `bandits:<player>`)
 * that now and then sends a band against one of their settlements. How often follows prestige: about
 * every `interval.normalMinutes`, sooner the faster the player's prestige rises (down to
 * `minMinutes`), never longer than `maxMinutes`. No bands during the first `protection.hours` after
 * the capital is founded, nor below `protection.prestige`.
 *
 * A band is drawn by the land around its target (`terrain.mix`: kinds name the terrains they come
 * from), its level by the player's prestige now, its lanes from the kind's families. It shows in the
 * incoming warnings and arrives after a lead time set by the player's scouting (stat
 * `armies.scouting`); then it fights the garrison like any attack (`pvp.raid`): winning, it plunders
 * and the player loses prestige for what was lost; beaten, the player gains prestige for its fallen
 * and draws from the drop pool (`addDrop`). Bands do not stay on the map.
 *
 * Content defines the kinds and levels (`defineKindsFromCsv`, `defineLevelsFromCsv`), may weigh the
 * targets (`setTargetWeight`) and adds drops.
 */
import {
	csvMap,
	csvNumber,
	csvRows,
	csvRules,
	definePlugin,
	GameError,
	numberFields,
	PluginError,
	seededRandom,
	type EngineApi,
	type ReadApi,
} from '../../kernel';
import type { RewardLine } from '../../shared/api';
import type { Lane } from '../battle';
import type { Settlement } from '../settlements';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

const RULES = csvRules(rulesCsv) as Record<string, Record<string, number>>;
const SPAWN = 'bandits.spawn';
const ARRIVE = 'bandits.arrive';

export interface BanditKind {
	id: string;
	name: string;
	/** Terrains it comes from. */
	terrains: string[];
	/** How likely each lane is of each unit family (relative weights). */
	families: Record<string, number>;
}

export interface BanditLevel {
	/** How the band's units split over the tiers (relative weights; the highest tier listed is the band's best). */
	mix: Record<number, number>;
	/** Named leaders from this level, and their bonuses to the whole band (%; casualty: fewer losses). */
	heroes: number;
	heroAttack: number;
	heroDefense: number;
	heroHp: number;
	heroCasualty: number;
}

export interface BanditDropContext {
	playerId: string;
	settlementId: string;
	kind: BanditKind;
	level: number;
	random: () => number;
}

export interface BanditDrop {
	id: string;
	/** Relative weight in the pool, by the band beaten (0 = not there). */
	weight: number | ((kind: BanditKind, level: number) => number);
	give(api: EngineApi, c: BanditDropContext): Promise<RewardLine[]>;
}

/** Relative chance a settlement is the next target (0 = never), given the default weight (its stocks + 1). */
export type TargetWeight = (api: ReadApi, settlement: Settlement, base: number, at: number) => Promise<number>;

export interface BanditsService {
	defineKind(kind: BanditKind): void;
	/** Columns id, name, terrains ("forest; hills"), families ("archer:3; infantry:1"). */
	defineKindsFromCsv(csv: string): void;
	/** Columns level (1, 2, ...), mix ("1:4; 2:1", tiers' shares), heroes, heroAttack, heroDefense, heroHp, heroCasualty. */
	defineLevelsFromCsv(csv: string): void;
	setTargetWeight(weight: TargetWeight): void;
	addDrop(drop: BanditDrop): void;
	/** Start the player's bandit timeline if it is not running (idempotent). */
	ensure(api: EngineApi, playerId: string): Promise<void>;
}

declare module '../../kernel' {
	interface ServiceMap {
		bandits: BanditsService;
	}
}

interface RaidRow {
	id: string;
	player_id: string;
	settlement_id: string;
	kind: string;
	level: number;
	lanes: string;
	heroes: string;
	appeared_at: number;
	arrives_at: number;
}

export default definePlugin({
	id: 'bandits',
	version: '0.1.0',
	description: 'Bandits raid players now and then, more often as their prestige rises',
	dependsOn: [
		'timeline',
		'settlements',
		'resources',
		'troops',
		'battle',
		'pvp',
		'armies',
		'prestige',
		'terrain',
		'heroes',
		'stats',
		'i18n',
	],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const timeline = ctx.services.get('timeline');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const troops = ctx.services.get('troops');
		const battle = ctx.services.get('battle');
		const pvp = ctx.services.get('pvp');
		const armies = ctx.services.get('armies');
		const prestige = ctx.services.get('prestige');
		const terrain = ctx.services.get('terrain');
		const heroes = ctx.services.get('heroes');
		const stats = ctx.services.get('stats');

		const rules = ctx.config.define('rules', {
			description:
				'interval: minutes between bands (normal, min, max; growth: how much a fast-rising prestige shortens it; jitter: random share). protection: hours after the capital and prestige before any band. lead: minutes from a band appearing to its arrival by scouting level (0, 1, 2, 3...). prestige: factors on resources lost / bandits slain. level: ranks per band level, random spread. size: how many come = base + perPrestige x prestige^exponent, give or take jitter; laneJitter / mixJitter: how unevenly they split over lanes and tiers. drops: chance of a first and a second drop.',
			default: () => RULES,
			parse(raw) {
				const r = (raw ?? {}) as Record<string, unknown>;
				const out: Record<string, Record<string, number>> = {};
				for (const k of Object.keys(RULES)) out[k] = numberFields(() => RULES[k], 0, 1e6)(r[k] ?? {});
				for (const k of Object.keys(r)) if (!(k in RULES)) throw new GameError('bad_config', `Unknown section "${k}"`, 400, 'bandits');
				return out;
			},
		});

		const kinds = new Map<string, BanditKind>();
		const levels: BanditLevel[] = [];
		const drops: BanditDrop[] = [];
		let targetWeight: TargetWeight = async (_api, _s, base) => base;

		const entity = (playerId: string) => `bandits:${playerId}`;
		timeline.addOwnerResolver('bandits', async (_db, id) => id);

		const loadRaid = (api: ReadApi, id: string) =>
			api.memo(`bandits:raid:${id}`, () => api.db.prepare('SELECT * FROM bandits_raids WHERE id = ?').bind(id).first<RaidRow>());
		const raidsOf = (api: ReadApi, playerId: string) =>
			api.memo(`bandits:raids:${playerId}`, async () => {
				const { results } = await api.db.prepare('SELECT * FROM bandits_raids WHERE player_id = ?').bind(playerId).all<RaidRow>();
				return results;
			});

		/** Minutes to the next band: shorter while prestige rises fast (gains lately against what the player has). */
		async function interval(api: ReadApi, playerId: string, random: () => number) {
			const r = rules.get(api).interval;
			const p = await prestige.get(api, playerId);
			const growth = p.recent / Math.max(p.value, 100);
			const minutes = (r.normalMinutes / (1 + r.growth * growth)) * (1 - r.jitter + 2 * r.jitter * random());
			return Math.min(r.maxMinutes, Math.max(r.minMinutes, minutes));
		}

		/** Band level by the prestige the player has now (not their best: beaten down, the bands get weaker). */
		function levelFor(api: ReadApi, value: number, random: () => number) {
			const r = rules.get(api).level;
			const base = Math.ceil((prestige.rankAt(value) + 1) / Math.max(1, r.ranksPerLevel));
			const spread = Math.round(r.spread);
			return Math.max(1, Math.min(levels.length, base + Math.floor(random() * (2 * spread + 1)) - spread));
		}

		const unitOf = (family: string, tier: number) => troops.list().find((u) => u.family === family && u.tier === tier)?.id;
		const pickWeighted = <T>(items: [T, number][], random: () => number): T | null => {
			const total = items.reduce((a, [, w]) => a + Math.max(0, w), 0);
			if (total <= 0) return null;
			let x = random() * total;
			for (const [item, w] of items) if ((x -= Math.max(0, w)) < 0) return item;
			return items[items.length - 1][0];
		};

		/**
		 * The band's troops: how many by the player's prestige now, which tiers by the band's level, spread
		 * unevenly (a random share per lane, each tier's share shaken a little) so no two bands look alike.
		 */
		function composeLanes(api: ReadApi, kind: BanditKind, row: BanditLevel, value: number, random: () => number): Lane[] {
			const size = rules.get(api).size;
			const shake = (jitter: number) => 1 - jitter + 2 * jitter * random();
			const total = (size.base + size.perPrestige * Math.max(0, value) ** size.exponent) * shake(Math.min(0.9, size.jitter));
			const laneShares = Array.from({ length: 5 }, () => shake(Math.min(0.9, size.laneJitter)));
			const laneSum = laneShares.reduce((a, b) => a + b, 0);
			return laneShares.map((share) => {
				const family = pickWeighted(Object.entries(kind.families), random) ?? Object.keys(kind.families)[0];
				const tiers = Object.entries(row.mix).map(([tier, w]) => [Number(tier), w * shake(Math.min(0.9, size.mixJitter))] as const);
				const mixSum = tiers.reduce((a, [, w]) => a + w, 0) || 1;
				const units: Record<string, number> = {};
				for (const [tier, w] of tiers) {
					const unit = unitOf(family, tier);
					const n = Math.round((total * share * w) / (laneSum * mixSum));
					if (unit && n > 0) units[unit] = (units[unit] ?? 0) + n;
				}
				return { family, units };
			});
		}

		/** Send a band against one of the player's settlements at `at`. Returns the raid id, or null (no target). */
		async function spawn(api: EngineApi, playerId: string, at: number, random: () => number, only?: string) {
			if (!kinds.size || !levels.length) return null;
			const busy = new Set((await raidsOf(api, playerId)).map((r) => r.settlement_id));
			const candidates: [Settlement, number][] = [];
			for (const s of await settlements.mine(api, playerId)) {
				if (busy.has(s.id) || (only && s.id !== only)) continue;
				const stock = Object.values(await resources.amounts(api, settlements.entity(s.id))).reduce((a, b) => a + Math.max(0, b), 0);
				candidates.push([s, await targetWeight(api, s, stock + 1, at)]);
			}
			const target = pickWeighted(candidates, random);
			if (!target) return null;

			const mix = await terrain.mix(api, { x: target.x, y: target.y });
			const from = pickWeighted(Object.entries(mix), random);
			const fitting = [...kinds.values()].filter((k) => from && k.terrains.includes(from));
			const kind = (fitting.length ? fitting : [...kinds.values()])[Math.floor(random() * (fitting.length || kinds.size))];
			const value = (await prestige.get(api, playerId)).value;
			const level = levelFor(api, value, random);
			const row = levels[level - 1];
			const lanes = composeLanes(api, kind, row, value, random);
			const names = Array.from({ length: row.heroes }, () => {
				const n = heroes.randomName(random);
				// Name parts stay keys ("s:Zhao m:Zilong"): clients spell them.
				return `${n.surname} ${n.given}`;
			});
			const scouting = await stats.get(api, 'armies.scouting', `player:${playerId}`);
			const lead = rules.get(api).lead;
			const steps = Object.keys(lead)
				.filter((k) => /^\d+$/.test(k))
				.map(Number)
				.sort((a, b) => a - b);
			const step = steps.filter((k) => k <= scouting).pop() ?? steps[0];
			const minutes = Math.min(lead.max ?? 60, Math.max(lead.min ?? 3, lead[step] ?? 3));
			const id = crypto.randomUUID();
			const arrivesAt = at + Math.round(minutes * 60_000);
			api.write(
				api.db
					.prepare(
						'INSERT INTO bandits_raids (id, player_id, settlement_id, kind, level, lanes, heroes, appeared_at, arrives_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
					)
					.bind(id, playerId, target.id, kind.id, level, JSON.stringify(lanes), JSON.stringify(names), at, arrivesAt),
			);
			timeline.schedule(api, settlements.entity(target.id), arrivesAt, ARRIVE, { raid: id });
			return id;
		}

		async function scheduleNext(api: EngineApi, playerId: string, from: number, random: () => number) {
			const next = from + Math.round((await interval(api, playerId, random)) * 60_000);
			api.write(
				api.db
					.prepare(
						'INSERT INTO bandits_players (player_id, next_at) VALUES (?, ?) ON CONFLICT (player_id) DO UPDATE SET next_at = excluded.next_at',
					)
					.bind(playerId, next),
			);
			timeline.schedule(api, entity(playerId), next, SPAWN, {});
		}

		const service: BanditsService = {
			defineKind(kind) {
				if (kinds.has(kind.id)) throw new PluginError(`Bandit kind "${kind.id}" defined twice`);
				kinds.set(kind.id, { ...kind, name: ctx.services.get('i18n').own(kind.name) });
			},
			defineKindsFromCsv(csv) {
				for (const r of csvRows(csv))
					service.defineKind({
						id: r.id,
						name: r.name,
						terrains: r.terrains
							.split(';')
							.map((t) => t.trim())
							.filter(Boolean),
						families: csvMap(r.families),
					});
			},
			defineLevelsFromCsv(csv) {
				if (levels.length) throw new PluginError('Bandit levels defined twice');
				const rows = csvRows(csv);
				rows.forEach((r, i) => {
					if (csvNumber(r, 'level') !== i + 1) throw new PluginError(`Bandit levels: expected level ${i + 1}`);
					levels.push({
						mix: Object.fromEntries(Object.entries(csvMap(r.mix)).map(([t, n]) => [Number(t), n])),
						heroes: csvNumber(r, 'heroes', 0),
						heroAttack: csvNumber(r, 'heroAttack', 0),
						heroDefense: csvNumber(r, 'heroDefense', 0),
						heroHp: csvNumber(r, 'heroHp', 0),
						heroCasualty: csvNumber(r, 'heroCasualty', 0),
					});
				});
			},
			setTargetWeight: (w) => void (targetWeight = w),
			addDrop(drop) {
				if (drops.some((d) => d.id === drop.id)) throw new PluginError(`Bandit drop "${drop.id}" defined twice`);
				// What it hands out is named in i18n keys of the plugin adding it.
				const own = ctx.services.get('i18n').scope();
				drops.push({ ...drop, give: async (api, c) => (await drop.give(api, c)).map((l) => ({ ...l, name: own(l.name) })) });
			},
			async ensure(api, playerId) {
				const known = await api.memo(`bandits:player:${playerId}`, async () => ({
					running: !!(await api.db.prepare('SELECT 1 FROM bandits_players WHERE player_id = ?').bind(playerId).first()),
				}));
				if (known.running) return;
				known.running = true;
				await scheduleNext(api, playerId, api.now, seededRandom(`bandits:first:${playerId}`));
			},
		};
		ctx.services.provide('bandits', service);

		// The timeline starts with the player's first settlement, or (for players from before) their next spending.
		settlements.onFounded(async (api, s) => {
			if (s.ownerId) await service.ensure(api, s.ownerId);
		});
		resources.onSpent(async (api, { holder }) => {
			if (!holder.startsWith('settlement:') || !api.playerId) return;
			const s = await settlements.get(api, holder.slice('settlement:'.length));
			if (s?.ownerId === api.playerId) await service.ensure(api, api.playerId);
		});

		timeline.on(SPAWN, async (api, event) => {
			const playerId = event.entity.slice('bandits:'.length);
			const random = seededRandom(`bandits:${event.id}`);
			await scheduleNext(api, playerId, event.dueAt, random);
			const p = rules.get(api).protection;
			const capital = await settlements.capital(api, playerId);
			if (!capital || event.dueAt < capital.createdAt + p.hours * 3_600_000) return;
			if ((await prestige.get(api, playerId)).value < p.prestige) return;
			await spawn(api, playerId, event.dueAt, random);
		});

		// The band's leaders, for the whole band.
		battle.addModifier(async (api, side) => {
			if (side.role !== 'attacker' || !side.armyId?.startsWith('bandits:')) return [];
			const raid = await loadRaid(api, side.armyId.slice('bandits:'.length));
			const row = raid && levels[raid.level - 1];
			if (!raid || !row?.heroes) return [];
			const source = `Bandit leaders: ${(JSON.parse(raid.heroes) as string[]).join(', ')}`;
			const out: Awaited<ReturnType<Parameters<typeof battle.addModifier>[0]>> = [];
			if (row.heroAttack) out.push({ source, stat: 'attack', percent: row.heroAttack });
			if (row.heroDefense) out.push({ source, stat: 'defense', percent: row.heroDefense });
			if (row.heroHp) out.push({ source, stat: 'hp', percent: row.heroHp });
			if (row.heroCasualty) out.push({ source, stat: 'casualty', percent: -row.heroCasualty });
			return out;
		});

		/** Base training cost of units at their tier now (no discounts; tiers 5-6 follow the same curve). */
		const worth = (api: ReadApi, units: Record<string, number>) =>
			Object.entries(units).reduce((sum, [u, n]) => sum + n * Object.values(troops.stats(api, u).cost).reduce((a, b) => a + b, 0), 0);

		timeline.on<{ raid: string }>(ARRIVE, async (api, event) => {
			const raid = await loadRaid(api, event.payload.raid);
			if (!raid) return;
			api.write(api.db.prepare('DELETE FROM bandits_raids WHERE id = ?').bind(raid.id));
			const target = await settlements.get(api, raid.settlement_id);
			const kind = kinds.get(raid.kind);
			if (!target || target.ownerId !== raid.player_id || !kind) return; // lost or gone meanwhile: the band moves on
			const lanes = JSON.parse(raid.lanes) as Lane[];
			const units: Record<string, number> = {};
			for (const l of lanes) for (const [u, n] of Object.entries(l.units)) units[u] = (units[u] ?? 0) + n;
			const random = seededRandom(`bandits:fight:${raid.id}`);
			await pvp.raid(api, {
				target,
				attacker: { side: { role: 'attacker', playerId: null, settlement: null, armyId: `bandits:${raid.id}` }, lanes, units },
				attackerId: null,
				attackerInfo: { name: kind.name, level: raid.level },
				at: event.dueAt,
				after: async (fight, loot) => {
					const r = rules.get(api).prestige;
					const playerId = raid.player_id;
					if (fight.victory) {
						// Lost: what they took, and the defenders who fell (at their tier now).
						const lost = Object.values(loot).reduce((a, b) => a + b, 0) + worth(api, fight.losses.defender);
						const delta = -lost * r.lossFactor * r.perResource;
						const before = (await prestige.get(api, playerId)).value;
						await prestige.add(api, playerId, delta);
						return { prestige: Math.max(delta, -before) };
					}
					const delta = worth(api, fight.losses.attacker) * r.winFactor * r.perResource;
					await prestige.add(api, playerId, delta);
					const rewards: RewardLine[] = [];
					const d = rules.get(api).drops;
					const pool = drops.map(
						(x) => [x, typeof x.weight === 'function' ? x.weight(kind, raid.level) : x.weight] as [BanditDrop, number],
					);
					for (const chance of [d.first, d.second]) {
						if (random() >= chance) break;
						const drop = pickWeighted(pool, random);
						if (drop) rewards.push(...(await drop.give(api, { playerId, settlementId: target.id, kind, level: raid.level, random })));
					}
					return { prestige: delta, rewards };
				},
			});
		});

		armies.addIncoming(async (api, playerId) =>
			(await raidsOf(api, playerId)).map((r) => {
				const units: Record<string, number> = {};
				for (const l of JSON.parse(r.lanes) as Lane[]) for (const [u, n] of Object.entries(l.units)) units[u] = (units[u] ?? 0) + n;
				return { id: r.id, settlement: r.settlement_id, arrivesAt: r.arrives_at, attackerName: kinds.get(r.kind)?.name ?? r.kind, units };
			}),
		);

		ctx.commands.add<{ settlement: string | null }>({
			type: 'bandits.spawn',
			privileged: true,
			description:
				'Send a band at the player now (ignores protection and the schedule; still one band per settlement). Payload: { "settlement"?: "<id>" }',
			form: {
				title: 'Send bandits',
				placement: 'gm',
				fields: [{ name: 'settlement', label: 'Settlement id (empty: drawn)', type: 'text' }],
				submitLabel: 'Send',
			},
			parse(raw) {
				const s = (raw as { settlement?: unknown } | null)?.settlement;
				if (s !== undefined && s !== null && s !== '' && typeof s !== 'string')
					throw new GameError('bad_payload', 'settlement must be an id', 400, 'bandits');
				return { settlement: (s as string) || null };
			},
			async execute(api, { settlement }) {
				const id = await spawn(api, api.playerId, api.now, seededRandom(`bandits:gm:${crypto.randomUUID()}`), settlement ?? undefined);
				if (!id) throw new GameError('no_target', 'No settlement to send bandits at', 400, 'bandits');
			},
		});

		ctx.reports.add({
			id: 'bandits.raids',
			description: 'Bandit bands on their way now.',
			async run(api) {
				const { results } = await api.db
					.prepare(
						'SELECT player_id AS playerId, settlement_id AS settlement, kind, level, appeared_at AS appearedAt, arrives_at AS arrivesAt FROM bandits_raids ORDER BY arrives_at LIMIT 200',
					)
					.all();
				return results;
			},
		});
	},
});
