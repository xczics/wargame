/**
 * Troops: unit types, training, garrisons and their upkeep.
 *
 * The plugin knows nothing about what trains a unit or what the units are: content plugins
 * define them (numbers may follow tunable rules) and add training gates (e.g. "needs a
 * barracks") through `addTrainingGate`.
 *
 * Units are trained in batches (one batch at a time per settlement, finished by the
 * timeline) in settlements whose kind allows a garrison. Every garrisoned unit costs
 * upkeep per second, registered as a resources consumer — so an army that outgrows its
 * economy drains the pool and triggers shortage rounds (see `shortageRound` below and
 * the `resources.depleted` event).
 */
import { csvRules, definePlugin, type EngineApi, GameError, numberInRange, PluginError, type ReadApi } from '../../kernel';
import type { GarrisonInfo, UnitNumbers } from '../../shared/api';
import type { TimersData, UiTimer } from '../../shared/ui';
import type { Cost } from '../resources';
import type { Settlement } from '../settlements';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

/** Design numbers (./data/rules.csv); GM overrides go on top. */
const RULES = csvRules(rulesCsv);

/** A unit's numbers. */
export interface UnitStats {
	attack: number;
	defense: number;
	hp: number;
	/** Marching speed in tiles per hour. */
	speed: number;
	/** Loot each unit can carry home. */
	carry: number;
	/** Cost per unit. */
	cost: Cost;
	/** Training time per unit, in seconds (before `troops.speed` and training modifiers). */
	seconds: number;
	/** Upkeep per unit per second, by resource. */
	upkeep: Record<string, number>;
}

export interface UnitDef {
	id: string;
	name: string;
	icon?: string;
	/** Grouping used by other systems (e.g. "infantry"); units of one family differ by `tier`. */
	family?: string;
	/** Rank within the family, 1 = lowest. */
	tier?: number;
	/** False: never trained, only obtained otherwise (e.g. promotion in battle). Default true. */
	trainable?: boolean;
	/**
	 * Where players train it: an entry type of the client, e.g. the id of the building that
	 * trains it (the training form shows up there). The troops plugin does not interpret it.
	 * Units without one can only be trained through the API.
	 */
	trainedAt?: string;
	/** The numbers, or a function of the current rules so the GM can tune them. Must only read. */
	stats: UnitStats | ((api: ReadApi) => UnitStats);
}

/** Why `unit` cannot be trained in a settlement (ignoring cost), or null. Must only read. */
export type TrainingGate = (api: EngineApi, settlement: Settlement, unit: UnitDef) => Promise<string | null>;
/**
 * Something a training batch needs and uses up besides resources, e.g. training quota from
 * items. `check` explains what is missing (null = fine); `consume` takes it in the same commit.
 */
export interface TrainingRequirement {
	check(api: EngineApi, settlement: Settlement, unit: UnitDef, count: number): Promise<string | null>;
	consume(api: EngineApi, settlement: Settlement, unit: UnitDef, count: number): Promise<void>;
}
export type ShortageRule = (unit: UnitDef, resource: string) => 'rout' | 'downgrade' | null;
/** What one shortage round did to a garrison. Runs in the timeline. */
export interface ShortageRound {
	settlementId: string;
	resource: string;
	at: number;
	/** Units that left, by id. */
	routed: Record<string, number>;
	/** Units that dropped a tier. */
	downgraded: { from: string; to: string; count: number }[];
}
/** Multiplier on training time, e.g. a higher-level barracks (0.55 = 45% faster). Must only read. */
export type TrainingTimeModifier = (api: EngineApi, settlement: Settlement, unit: UnitDef) => Promise<number>;

export interface TroopsService {
	define(def: UnitDef): void;
	list(): readonly UnitDef[];
	get(id: string): UnitDef | undefined;
	/** A unit's numbers under the current rules. Unknown units have none (all zero). */
	stats(api: ReadApi, id: string): UnitStats;
	/** Sums over a set of units: attack, defense, hp, carry; `speed` is the slowest unit's (0 if none). */
	totals(api: ReadApi, units: Record<string, number>): { attack: number; defense: number; hp: number; carry: number; speed: number };
	addTrainingGate(gate: TrainingGate): void;
	addTrainingTimeModifier(modifier: TrainingTimeModifier): void;
	addTrainingRequirement(requirement: TrainingRequirement): void;
	/**
	 * What units do when upkeep drains `resource`: 'rout' (leave, the default) or 'downgrade'
	 * (drop one tier in their family; the lowest tier leaves). The first rule with an answer wins.
	 */
	addShortageRule(rule: ShortageRule): void;
	/** Told after every shortage round that cost units (e.g. to notify the player). */
	onShortage(listener: (api: EngineApi, round: ShortageRound) => Promise<void>): void;
	/** Multiplier on a settlement's garrison upkeep (e.g. 0.9 = 10% less), e.g. from a governor. Must only read. */
	addUpkeepModifier(modifier: (api: ReadApi, settlementId: string) => Promise<number>): void;
	/** Garrison counts by unit id (due training applied; changes in a command are reflected). */
	garrison(api: EngineApi, settlementId: string): Promise<Map<string, number>>;
	/** Change a garrison (settles the pool first, since upkeep changes). Clamps at 0. */
	adjust(api: EngineApi, settlementId: string, unit: string, delta: number): Promise<void>;
	/** Attack / defence / hp totals of a garrison, for display (battles add their own modifiers). */
	power(api: EngineApi, settlementId: string): Promise<{ attack: number; defense: number; hp: number }>;
	/**
	 * Take `seconds` off a batch training in a settlement (e.g. an item); at 0 it completes now. `line`: the
	 * barracks type (default: whichever batch finishes soonest). False if nothing trains there.
	 */
	speedUp(api: EngineApi, settlementId: string, seconds: number, line?: string): Promise<boolean>;
	/** The settlement's training: per barracks type (`line`), the batch training (times set) and the plans waiting. */
	queue(
		api: EngineApi,
		settlementId: string,
	): Promise<readonly { id: string; line: string; unit: string; count: number; startedAt: number | null; finishesAt: number | null }[]>;
}

declare module '../../kernel' {
	interface ServiceMap {
		troops: TroopsService;
	}
}

const TRAINED = 'troops.trained';
/** Kept from when shortages made a share of troops desert, so pending events still run. */
const SHORTAGE = 'troops.deficit';

export default definePlugin({
	id: 'troops',
	version: '0.1.0',
	description: 'Unit types, training, garrisons and upkeep',
	dependsOn: ['settlements', 'resources', 'timeline', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv);
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const timeline = ctx.services.get('timeline');
		const defs = new Map<string, UnitDef>();
		const shortageListeners: ((api: EngineApi, round: ShortageRound) => Promise<void>)[] = [];
		const trainingGates: TrainingGate[] = [];
		const timeModifiers: TrainingTimeModifier[] = [];
		const requirements: TrainingRequirement[] = [];
		const shortageRules: ShortageRule[] = [];
		const upkeepModifiers: ((api: ReadApi, settlementId: string) => Promise<number>)[] = [];
		const upkeepFactor = async (api: ReadApi, settlementId: string) => {
			let f = 1;
			for (const m of upkeepModifiers) f *= await m(api, settlementId);
			return Math.max(0, f);
		};
		const reactionTo = (unit: string, resource: string) => {
			const def = defs.get(unit);
			for (const rule of def ? shortageRules : []) {
				const r = rule(def!, resource);
				if (r) return r;
			}
			return 'rout' as const;
		};
		const NONE: UnitStats = { attack: 0, defense: 0, hp: 0, speed: 0, carry: 0, cost: {}, seconds: 0, upkeep: {} };
		const statsOf = (api: ReadApi, id: string): UnitStats => {
			const def = defs.get(id);
			if (!def) return NONE;
			// Formulas are cheap; computing on every call keeps GM changes effective at once.
			return typeof def.stats === 'function' ? def.stats(api) : def.stats;
		};

		const speed = ctx.config.define('speed', {
			description: 'Training speed multiplier (2 = twice as fast).',
			default: () => 1,
			parse: numberInRange(0.01, 1e6),
		});
		const maxBatch = ctx.config.define('maxBatch', {
			description: 'Most units per training batch.',
			default: () => 1000,
			parse: numberInRange(1, 1e7),
		});

		const loadGarrison = (api: ReadApi, settlementId: string) =>
			api.memo(`troops:garrison:${settlementId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT unit, count FROM troops_garrison WHERE settlement_id = ?')
					.bind(settlementId)
					.all<{ unit: string; count: number }>();
				return new Map(results.map((r) => [r.unit, r.count]));
			});
		/** The barracks queue a unit trains in (its building type). */
		const lineOf = (unit: string) => defs.get(unit)?.trainedAt ?? '';
		/** Training batches of a settlement, every barracks: running first in each line, then the plans in order. */
		const loadQueue = (api: ReadApi, settlementId: string) =>
			api.memo(`troops:queue:${settlementId}`, async () => {
				const { results } = await api.db.prepare('SELECT * FROM troops_queue WHERE settlement_id = ? ORDER BY seq').bind(settlementId).all<{
					id: string;
					line: string;
					seq: number;
					unit: string;
					count: number;
					cost: string;
					started_at: number | null;
					finishes_at: number | null;
				}>();
				return results.map((r) => ({
					id: r.id,
					// Moved over from before queues: the line comes from the unit.
					line: r.line || lineOf(r.unit),
					seq: r.seq,
					unit: r.unit,
					count: r.count,
					cost: JSON.parse(r.cost) as Cost,
					startedAt: r.started_at,
					finishesAt: r.finishes_at,
				}));
			});
		type Batch = Awaited<ReturnType<typeof loadQueue>>[number];
		/** Start a waiting batch at `at`: its time is worked out now (barracks, research, heroes as they are). */
		async function startBatch(api: EngineApi, s: Settlement, b: Batch, at: number) {
			const def = defs.get(b.unit);
			const seconds = def ? await secondsPerUnit(api, s, def) : 1;
			b.startedAt = at;
			b.finishesAt = at + Math.max(1, Math.ceil(seconds * b.count)) * 1000;
			api.write(
				api.db.prepare('UPDATE troops_queue SET started_at = ?, finishes_at = ? WHERE id = ?').bind(b.startedAt, b.finishesAt, b.id),
			);
			timeline.schedule(api, settlements.entity(s.id), b.finishesAt, TRAINED, { settlementId: s.id, id: b.id });
		}
		const writeCount = (api: EngineApi, settlementId: string, unit: string, count: number) =>
			api.write(
				api.db
					.prepare(
						'INSERT INTO troops_garrison (settlement_id, unit, count) VALUES (?, ?, ?) ON CONFLICT (settlement_id, unit) DO UPDATE SET count = excluded.count',
					)
					.bind(settlementId, unit, count),
			);
		const shortageRounds = ctx.config.define('shortageRounds', {
			description:
				'When upkeep drains a resource to its floor, troops that need it leave (or drop a tier) in this many rounds, so that unchanged income and upkeep balance after the last one.',
			default: () => RULES.shortageRounds as number,
			parse: numberInRange(1, 1000),
		});
		const shortageInterval = ctx.config.define('shortageInterval', {
			description: 'Seconds between shortage rounds (12 rounds x 3600 s = balanced within 12 hours).',
			default: () => RULES.shortageInterval as number,
			parse: numberInRange(10, 1e7),
		});

		/** Upkeep of `resource` per second of one unit. */
		const upkeepOf = (api: ReadApi, unit: string, resource: string) => statsOf(api, unit).upkeep[resource] ?? 0;
		/** The unit one tier below in the same family, if any. */
		const lowerTier = (unit: UnitDef) =>
			unit.family && unit.tier ? [...defs.values()].find((d) => d.family === unit.family && d.tier === unit.tier! - 1) : undefined;

		/**
		 * Take `cut` per second off the garrison's upkeep of `resource`. Units that `downgrade`
		 * drop one tier, highest tier first (the lowest tier leaves instead); the others rout,
		 * lowest tier first. Within a tier, the cut is shared in proportion to the counts.
		 */
		function reduce(api: EngineApi, settlementId: string, g: Map<string, number>, resource: string, cut: number) {
			const routed: Record<string, number> = {};
			const downgraded: ShortageRound['downgraded'] = [];
			const set = (unit: string, count: number) => {
				g.set(unit, count);
				writeCount(api, settlementId, unit, count);
			};
			/** `n` units of `unit` leave, or drop to `lower`. */
			const move = (unit: string, n: number, lower: UnitDef | undefined) => {
				set(unit, g.get(unit)! - n);
				if (lower) {
					set(lower.id, (g.get(lower.id) ?? 0) + n);
					downgraded.push({ from: unit, to: lower.id, count: n });
				} else routed[unit] = (routed[unit] ?? 0) + n;
			};
			const candidates = [...g]
				.filter(([unit, n]) => n > 0 && upkeepOf(api, unit, resource) > 0)
				.map(([unit]) => ({ def: defs.get(unit)!, reaction: reactionTo(unit, resource) }));
			const byTier = (list: typeof candidates, dir: 1 | -1) => {
				const tiers = new Map<number, UnitDef[]>();
				for (const c of list) tiers.set(c.def.tier ?? 1, [...(tiers.get(c.def.tier ?? 1) ?? []), c.def]);
				return [...tiers.entries()].sort(([a], [b]) => (a - b) * dir).map(([, units]) => units);
			};
			// Per-unit saving: leaving saves all of its upkeep; dropping a tier saves the difference.
			const saving = (unit: UnitDef, downgrade: boolean) => {
				const lower = downgrade ? lowerTier(unit) : undefined;
				return upkeepOf(api, unit.id, resource) - (lower ? upkeepOf(api, lower.id, resource) : 0);
			};
			let left = cut;
			let changed = 0;
			const apply = (group: UnitDef[], downgrade: boolean) => {
				const total = group.reduce((sum, u) => sum + saving(u, downgrade) * g.get(u.id)!, 0);
				if (total <= 0) return;
				const share = Math.min(1, left / total);
				for (const u of group) {
					const n = g.get(u.id)!;
					const moved = Math.min(n, Math.ceil(n * share - 1e-9));
					if (!moved) continue;
					move(u.id, moved, downgrade ? lowerTier(u) : undefined);
					left -= moved * saving(u, downgrade);
					changed += moved;
				}
			};
			for (const group of byTier(
				candidates.filter((c) => c.reaction === 'downgrade'),
				-1,
			)) {
				if (left <= 1e-12) break;
				apply(group, true);
			}
			for (const group of byTier(
				candidates.filter((c) => c.reaction === 'rout'),
				1,
			)) {
				if (left <= 1e-12) break;
				apply(group, false);
			}
			// Every round costs at least one unit, so tiny deficits still end.
			if (!changed && cut > 0) {
				const first = candidates.find((c) => c.reaction === 'downgrade') ?? candidates[0];
				if (first) move(first.def.id, 1, first.reaction === 'downgrade' ? lowerTier(first.def) : undefined);
			}
			return { routed, downgraded };
		}

		/** Still short: upkeep exceeds income and the stock sits at its floor (or below zero). */
		const short = async (api: EngineApi, holder: string, resource: string) =>
			((await resources.rates(api, holder))[resource] ?? 0) < 0 && ((await resources.peekAmounts(api, holder))[resource] ?? 0) <= 0;

		/** One shortage round at the event time (the pool is already there); schedules the next. */
		async function shortageRound(api: EngineApi, settlementId: string, resource: string, at: number, roundsLeft: number) {
			const holder = settlements.entity(settlementId);
			if (!(await short(api, holder, resource))) return;
			const deficit = -((await resources.rates(api, holder))[resource] ?? 0);
			// Cut in raw per-unit upkeep: the garrison pays upkeep x its modifiers.
			const factor = await upkeepFactor(api, settlementId);
			if (factor > 0) {
				const done = reduce(api, settlementId, await loadGarrison(api, settlementId), resource, deficit / roundsLeft / factor);
				if (Object.keys(done.routed).length || done.downgraded.length)
					for (const l of shortageListeners) await l(api, { settlementId, resource, at, ...done });
			}
			// After the last round keep going one round at a time while it is still short
			// (e.g. income fell again), each taking the whole remaining deficit.
			timeline.schedule(api, holder, at + shortageInterval.get(api) * 1000, SHORTAGE, {
				settlementId,
				resource,
				roundsLeft: Math.max(1, roundsLeft - 1),
			});
		}

		const settlementOf = (holder: string) => (holder.startsWith('settlement:') ? holder.slice('settlement:'.length) : null);

		const service: TroopsService = {
			define(def) {
				if (defs.has(def.id)) throw new PluginError(`Unit "${def.id}" defined twice`);
				defs.set(def.id, def);
			},
			list: () => [...defs.values()],
			get: (id) => defs.get(id),
			onShortage: (l) => void shortageListeners.push(l),
			stats: statsOf,
			totals(api, units) {
				const out = { attack: 0, defense: 0, hp: 0, carry: 0, speed: 0 };
				let slowest = Infinity;
				for (const [unit, n] of Object.entries(units)) {
					if (!n) continue;
					const u = statsOf(api, unit);
					out.attack += u.attack * n;
					out.defense += u.defense * n;
					out.hp += u.hp * n;
					out.carry += u.carry * n;
					slowest = Math.min(slowest, u.speed);
				}
				out.speed = Number.isFinite(slowest) ? slowest : 0;
				return out;
			},
			addTrainingGate: (g) => void trainingGates.push(g),
			addTrainingTimeModifier: (m) => void timeModifiers.push(m),
			addTrainingRequirement: (r) => void requirements.push(r),
			addShortageRule: (r) => void shortageRules.push(r),
			addUpkeepModifier: (m) => void upkeepModifiers.push(m),
			async garrison(api, settlementId) {
				await timeline.sync(api, settlements.entity(settlementId));
				return loadGarrison(api, settlementId);
			},
			async queue(api, settlementId) {
				await timeline.sync(api, settlements.entity(settlementId));
				return loadQueue(api, settlementId);
			},
			async speedUp(api, settlementId, seconds, line) {
				const holder = settlements.entity(settlementId);
				await timeline.sync(api, holder); // what is due first
				// The batch training in that barracks, or the one finishing soonest.
				const t = (await loadQueue(api, settlementId))
					.filter((b) => b.finishesAt !== null && (line === undefined || b.line === line))
					.sort((a, b) => a.finishesAt! - b.finishesAt!)[0];
				if (!t) return false;
				t.finishesAt = Math.max(api.now, t.finishesAt! - seconds * 1000);
				api.write(api.db.prepare('UPDATE troops_queue SET finishes_at = ? WHERE id = ?').bind(t.finishesAt, t.id));
				timeline.cancelWhere(api, holder, TRAINED, { id: t.id });
				// From before queues: the event named the settlement only.
				if (t.id === settlementId) timeline.cancelWhere(api, holder, TRAINED, { settlementId });
				timeline.schedule(api, holder, t.finishesAt, TRAINED, { settlementId, id: t.id });
				await timeline.sync(api, holder);
				return true;
			},
			async power(api, settlementId) {
				const { attack, defense, hp } = service.totals(api, Object.fromEntries(await service.garrison(api, settlementId)));
				return { attack, defense, hp };
			},
			async adjust(api, settlementId, unit, delta) {
				await resources.settle(api, settlements.entity(settlementId));
				const g = await service.garrison(api, settlementId);
				const count = Math.max(0, (g.get(unit) ?? 0) + delta);
				g.set(unit, count);
				writeCount(api, settlementId, unit, count);
			},
		};
		ctx.services.provide('troops', service);

		// Upkeep: every garrisoned unit, every second.
		resources.addConsumer(async (api, holder) => {
			const id = settlementOf(holder);
			if (!id) return {};
			const out: Record<string, number> = {};
			const factor = await upkeepFactor(api, id);
			for (const [unit, count] of await loadGarrison(api, id)) {
				for (const [r, perUnit] of Object.entries(statsOf(api, unit).upkeep)) out[r] = (out[r] ?? 0) + perUnit * count * factor;
			}
			return out;
		});

		resources.onDepleted(async (api, e) => {
			const id = settlementOf(e.holder);
			if (!id) return;
			// A new shortage: drop any rounds still pending from an earlier one for this resource.
			timeline.cancelWhere(api, e.holder, SHORTAGE, { resource: e.resource });
			await shortageRound(api, id, e.resource, e.at, shortageRounds.get(api));
		});
		// `roundsLeft` is missing on events from before shortage rounds existed: start afresh.
		timeline.on<{ settlementId: string; resource: string; roundsLeft?: number }>(SHORTAGE, async (api, event) => {
			const { settlementId, resource, roundsLeft } = event.payload;
			await shortageRound(api, settlementId, resource, event.dueAt, roundsLeft ?? shortageRounds.get(api));
		});

		// `id` is missing on events from before queues: that batch's id is its settlement's.
		timeline.on<{ settlementId: string; id?: string }>(TRAINED, async (api, event) => {
			const { settlementId } = event.payload;
			const queue = await loadQueue(api, settlementId);
			const i = queue.findIndex((b) => b.id === (event.payload.id ?? settlementId));
			if (i < 0) return;
			const [done] = queue.splice(i, 1);
			// The pool was already advanced to this moment by the timeline; upkeep starts now.
			const g = await loadGarrison(api, settlementId);
			g.set(done.unit, (g.get(done.unit) ?? 0) + done.count);
			writeCount(api, settlementId, done.unit, g.get(done.unit)!);
			api.write(api.db.prepare('DELETE FROM troops_queue WHERE id = ?').bind(done.id));
			// The next plan in this barracks starts at once.
			const next = queue.find((b) => b.line === done.line && b.startedAt === null);
			const s = next && (await settlements.get(api, settlementId));
			if (next && s) await startBatch(api, s, next, event.dueAt);
		});

		/** Why `unit` cannot be trained in `s` right now (ignoring cost), or null. */
		async function blocked(api: EngineApi, s: Settlement, def: UnitDef): Promise<string | null> {
			if (def.trainable === false) return `${def.name} cannot be trained`;
			if (!settlements.kind(s.kind).garrison) return `${settlements.kind(s.kind).name} cannot hold troops`;
			for (const gate of trainingGates) {
				const reason = await gate(api, s, def);
				if (reason) return reason;
			}
			return null;
		}
		/** Seconds per unit in `s`, after the global speed and every modifier. */
		async function secondsPerUnit(api: EngineApi, s: Settlement, def: UnitDef) {
			let factor = 1;
			for (const m of timeModifiers) factor *= await m(api, s, def);
			return (statsOf(api, def.id).seconds * factor) / speed.get(api);
		}

		ctx.commands.add<{ settlement: string; unit: string; count: number }>({
			type: 'troops.train',
			description: 'Train a batch of units in a settlement.',
			form: {
				title: 'Train troops',
				placement: 'building',
				fields: [
					{ name: 'settlement', label: 'settlement', type: 'hidden' },
					{ name: 'unit', label: 'Unit', type: 'select', required: true },
					{ name: 'count', label: 'How many', type: 'number', required: true, min: 1, default: 10 },
				],
				submitLabel: 'Train',
				async prepare(api, params) {
					// In the entry of the building that trains them (params.type), for its settlement.
					const here = service.list().filter((d) => d.trainedAt && d.trainedAt === params.type);
					if (!here.length) return false;
					const s = await settlements.resolve(api, params);
					if (!s) return false;
					await service.garrison(api, s.id);
					const options: { value: string; label: string }[] = [];
					for (const d of here) {
						if (await blocked(api, s, d)) continue;
						const cost = Object.entries(statsOf(api, d.id).cost)
							.map(([r, n]) => `${n} ${r}`)
							.join(', ');
						options.push({ value: d.id, label: `${d.name} — ${cost} · ${Math.max(1, Math.ceil(await secondsPerUnit(api, s, d)))}s each` });
					}
					if (!options.length) return false;
					const busy = (await loadQueue(api, s.id)).some((b) => b.line === params.type);
					return {
						defaults: { settlement: s.id },
						options: { unit: options },
						description: busy
							? 'Queued after the batch training now: paid now, refunded if cancelled before it starts.'
							: 'Costs and time are per unit.',
					};
				},
			},
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.settlement !== 'string') throw new GameError('bad_payload', 'settlement is required');
				if (typeof p.unit !== 'string' || !defs.has(p.unit)) throw new GameError('bad_payload', 'Unknown unit');
				const count = Number(p.count);
				if (!Number.isInteger(count) || count < 1) throw new GameError('bad_payload', 'count must be a positive integer');
				return { settlement: p.settlement, unit: p.unit, count };
			},
			async execute(api, { settlement, unit, count }) {
				const s = await settlements.requireOwned(api, settlement);
				const def = defs.get(unit)!;
				await service.garrison(api, s.id); // process finished training first
				const reason = await blocked(api, s, def);
				if (reason) throw new GameError('blocked', reason);
				if (count > maxBatch.get(api)) throw new GameError('bad_payload', `At most ${maxBatch.get(api)} per batch`);
				for (const r of requirements) {
					const missing = await r.check(api, s, def, count);
					if (missing) throw new GameError('blocked', missing);
				}
				for (const r of requirements) await r.consume(api, s, def, count);
				// Paid now, plans included: what waits in a queue cannot be plundered, and comes back if cancelled.
				const cost = Object.fromEntries(Object.entries(statsOf(api, def.id).cost).map(([r, n]) => [r, n * count]));
				await resources.spend(api, settlements.entity(s.id), cost);
				const queue = await loadQueue(api, s.id);
				const line = lineOf(unit);
				const batch: Batch = {
					id: crypto.randomUUID(),
					line,
					seq: Math.max(0, ...queue.map((b) => b.seq)) + 1,
					unit,
					count,
					cost,
					startedAt: null,
					finishesAt: null,
				};
				queue.push(batch);
				api.write(
					api.db
						.prepare('INSERT INTO troops_queue (id, settlement_id, line, seq, unit, count, cost) VALUES (?, ?, ?, ?, ?, ?, ?)')
						.bind(batch.id, s.id, line, batch.seq, unit, count, JSON.stringify(cost)),
				);
				if (!queue.some((b) => b.line === line && b.startedAt !== null)) await startBatch(api, s, batch, api.now);
			},
		});

		ctx.commands.add<{ settlement: string; id: string }>({
			type: 'troops.cancel',
			description:
				'Cancel a training plan that has not started; what it cost comes back. Payload: { "settlement": "<id>", "id": "<plan id>" }',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.settlement !== 'string' || typeof p.id !== 'string')
					throw new GameError('bad_payload', 'settlement and id are required');
				return { settlement: p.settlement, id: p.id };
			},
			async execute(api, { settlement, id }) {
				const s = await settlements.requireOwned(api, settlement);
				await service.garrison(api, s.id); // what finished first (a plan may have started meanwhile)
				const queue = await loadQueue(api, s.id);
				const i = queue.findIndex((b) => b.id === id);
				if (i < 0) throw new GameError('not_found', 'No such training plan', 404);
				if (queue[i].startedAt !== null) throw new GameError('blocked', 'This batch is already training');
				const [plan] = queue.splice(i, 1);
				api.write(api.db.prepare('DELETE FROM troops_queue WHERE id = ?').bind(plan.id));
				await resources.refund(api, settlements.entity(s.id), plan.cost);
			},
		});

		ctx.commands.add<{ settlement: string; unit: string; count: number }>({
			type: 'troops.grant',
			form: {
				title: 'Add or remove troops',
				placement: 'gm',
				fields: [
					{ name: 'settlement', label: 'Settlement', type: 'select', required: true },
					{ name: 'unit', label: 'Unit', type: 'select', required: true },
					{ name: 'count', label: 'Count (negative to remove)', type: 'number', required: true, default: 10 },
				],
				submitLabel: 'Apply',
				async prepare(api) {
					const mine = (await settlements.mine(api, api.playerId)).filter((s) => settlements.kind(s.kind).garrison);
					if (!mine.length) return false;
					return {
						options: {
							settlement: mine.map((s) => ({ value: s.id, label: `${s.name} (${s.x}, ${s.y})` })),
							unit: service.list().map((d) => ({ value: d.id, label: d.name })),
						},
					};
				},
			},
			privileged: true,
			description: 'Add (or remove) garrison units. Payload: { "settlement": "<id>", "unit": "spearman", "count": 100 }',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.settlement !== 'string') throw new GameError('bad_payload', 'settlement is required');
				if (typeof p.unit !== 'string' || !defs.has(p.unit)) throw new GameError('bad_payload', 'Unknown unit');
				return { settlement: p.settlement, unit: p.unit, count: Math.trunc(numberInRange(-1e9, 1e9)(p.count)) };
			},
			async execute(api, { settlement, unit, count }) {
				if (!(await settlements.get(api, settlement))) throw new GameError('not_found', 'No such settlement', 404);
				await service.adjust(api, settlement, unit, count);
			},
		});

		// Static facts only; the numbers depend on the rules, see view `troops.units`.
		ctx.meta.add('units', () =>
			service
				.list()
				.map(({ id, name, icon, family, tier, trainable, trainedAt }) => ({ id, name, icon, family, tier, trainable, trainedAt })),
		);

		ctx.views.add({
			id: 'troops.units',
			async compute(api): Promise<UnitNumbers[]> {
				return service.list().map((d) => ({ id: d.id, ...statsOf(api, d.id) }));
			},
		});

		async function garrisonInfo(api: EngineApi, s: Settlement): Promise<GarrisonInfo> {
			const g = await service.garrison(api, s.id);
			const upkeep: Record<string, number> = {};
			const factor = await upkeepFactor(api, s.id);
			for (const [unit, count] of g) {
				for (const [r, perUnit] of Object.entries(statsOf(api, unit).upkeep)) upkeep[r] = (upkeep[r] ?? 0) + perUnit * count * factor;
			}
			return {
				settlement: s.id,
				allowed: settlements.kind(s.kind).garrison,
				units: [...g].filter(([, n]) => n > 0).map(([id, count]) => ({ id, count })),
				training: (await loadQueue(api, s.id)).map(({ id, line, unit, count, cost, startedAt, finishesAt }) => ({
					id,
					line,
					unit,
					count,
					cost,
					startedAt,
					finishesAt,
				})),
				power: await service.power(api, s.id),
				upkeep,
				trainable: await Promise.all(
					service
						.list()
						.filter((d) => d.trainable !== false)
						.map(async (d) => ({
							unit: d.id,
							cost: statsOf(api, d.id).cost,
							seconds: Math.max(1, Math.ceil(await secondsPerUnit(api, s, d))),
							blocked: (await blocked(api, s, d)) ?? undefined,
						})),
				),
			};
		}

		ctx.views.add({
			id: 'troops.garrison',
			async compute(api, params): Promise<GarrisonInfo | null> {
				const s = await settlements.resolve(api, params);
				return s ? garrisonInfo(api, s) : null;
			},
		});

		// Each barracks' queue for the generic timers widget on its entry: the batch training, then the
		// plans (cancellable for a refund); or why nothing can be trained there now.
		ctx.views.add({
			id: 'troops.training',
			async compute(api, params): Promise<TimersData | null> {
				const s = await settlements.resolve(api, params);
				if (!s) return null;
				const info = await garrisonInfo(api, s);
				const amount = (c: Cost) =>
					Object.entries(c)
						.map(([r, n]) => `${resources.list().find((x) => x.id === r)?.icon ?? r}${Math.round(n).toLocaleString('en-US')}`)
						.join(' ');
				const items = info.training.map((b): UiTimer => {
					const title = { text: '{unit} ×{n}', vars: { unit: defs.get(b.unit)?.name ?? b.unit, n: b.count } };
					return b.startedAt !== null
						? { id: b.id, where: b.line, title, startedAt: b.startedAt, endsAt: b.finishesAt! }
						: {
								id: b.id,
								where: b.line,
								title,
								lines: [{ text: { text: 'Waiting · {cost}', vars: { cost: amount(b.cost) } }, tone: 'muted' }],
								actions: [{ command: 'troops.cancel', payload: { settlement: s.id, id: b.id }, label: { text: 'Cancel (refund)' } }],
							};
				});
				const notes: NonNullable<TimersData['notes']> = [];
				for (const line of new Set(service.list().flatMap((d) => (d.trainedAt ? [d.trainedAt] : [])))) {
					if (items.some((i) => i.where === line)) {
						notes.push({
							where: line,
							text: { text: 'Paid when added; plans waiting cannot be plundered, and cancelling one returns its cost.' },
							tone: 'muted',
						});
						continue;
					}
					const here = info.trainable.filter((t) => defs.get(t.unit)?.trainedAt === line);
					if (here.length && here.every((t) => t.blocked)) notes.push({ where: line, text: { text: here[0].blocked! }, tone: 'muted' });
				}
				return { title: { text: 'Training' }, items, notes };
			},
		});

		// Every settlement of the player that can hold troops, for the army overview.
		ctx.views.add({
			id: 'troops.overview',
			async compute(api): Promise<GarrisonInfo[]> {
				const out: GarrisonInfo[] = [];
				for (const s of await settlements.mine(api, api.playerId))
					if (settlements.kind(s.kind).garrison) out.push(await garrisonInfo(api, s));
				return out;
			},
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.block({ page: 'armies', column: 'left', widget: 'troops.garrisons' });
		ui.entry({
			kind: 'building',
			widget: 'ui.timers',
			order: -50,
			props: { view: 'troops.training' },
			types: () => [...new Set(service.list().flatMap((u) => (u.trainedAt ? [u.trainedAt] : [])))],
		});
	},
});
