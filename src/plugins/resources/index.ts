/**
 * Resources (food, wood, ...): definitions plus resource pools in D1. A pool belongs to
 * a "holder" entity — normally a settlement (`settlement:<id>`), whose inner and outer
 * cities share it.
 *
 * Production is settled lazily. Each row stores the amount as of `updated_at`; reading
 * advances it with closed-form maths:
 *   - rates come from registered producers, under the CURRENT rules;
 *   - growth stops at the pool's capacity (stat `resources.capacity`), and an amount
 *     already above it (e.g. a GM grant) is kept but does not grow;
 *   - only the last `engine.maxOfflineSeconds` before now count.
 * Timeline events (a farm finishing) split time: the pool is advanced to the event's time
 * with the old rates before the event changes them (see the timeline plugin).
 *
 * Rule for plugins that change production or capacity outside the timeline: call
 * `settle()` first, so time already elapsed is credited under the old numbers.
 */
import {
	csvNumber,
	csvRows,
	csvRules,
	definePlugin,
	derive,
	type EngineApi,
	type FlatContext,
	fields,
	GameError,
	gameErrors,
	MAX_OFFLINE_SECONDS_KEY,
	numberInRange,
	numberRecord,
	PluginError,
	type ReadApi,
	shape,
	type ViewParams,
	flatPart,
	prefixed,
	derivedKind,
} from '../../kernel';
import type { ProductionRow, ProductionRows, ResourcePool } from '../../shared/api';
import type { UiText } from '../../shared/ui';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, uiTexts } from '../../shared/i18n';

// Its derived values (`api.derived`): key prefix and shape version, one place for every path.
const RATES = derivedKind('resources', 3);

const fail = gameErrors('resources');
const text = uiTexts('resources');

/** Design numbers (./data/rules.csv); GM overrides go on top. */
const RULES = csvRules(rulesCsv);
/** Stat of one resource's own production bonus, e.g. `resources.output.food` (1 = none; contributors add percent). */
const outputStat = (id: string) => `resources.output.${id}`;

export interface ResourceDef {
	id: string;
	name: string;
	icon?: string;
	/** Starting amount of a new pool. GM-tunable via `resources.initial`. */
	initial?: number;
}

export type Cost = Record<string, number>;

/** Production per second by resource id for one holder. Must only read. */
/**
 * Production per second of one resource: a number, or parts that each carry an extra percent
 * bonus of their own (e.g. terrain under one district), added to the holder's general factor.
 */
export type Production = number | { amount: number; percent: number; sources?: ProductionSource[] }[];
/** Where a part's own percent comes from (e.g. "Terrain +10%"), for the production table; they add up to `percent`. */
export interface ProductionSource {
	source: UiText;
	percent: number;
}
export type Producer = (api: ReadApi, holder: string) => Promise<Record<string, Production>>;

/**
 * Called when upkeep drains a resource to zero (at `at`, the exact moment). Typical use:
 * troops lose strength without metal, desert without gold. Runs inside the timeline, so it
 * may change state with `api.write` (call `settle` on the holder before changing upkeep).
 * Also runs (without effect) during read-only views: keep it free of other side effects.
 */
export type DepletedListener = (api: EngineApi, event: { holder: string; resource: string; at: number }) => Promise<void>;

/**
 * Why resources leave a pool through `spend`: the player paying for something (building, training...),
 * upkeep paid up front (e.g. a march), resources moved elsewhere (a march's supplies) or lost (raided).
 */
export type SpendPurpose = 'spend' | 'upkeep' | 'transfer' | 'loss';
/** Told about every `spend` and every refund (cancelled work) once it is applied. Must only use `api.write`. */
export type CostListener = (api: EngineApi, event: { holder: string; cost: Cost; purpose: SpendPurpose }) => Promise<void>;

/**
 * A spend listener's flat form (`Command.flat`, docs/development.md §2.3): what it reads, and the writes it makes from
 * those rows (null: the regular path). Listeners without one keep spending off the fast path.
 */
export interface FlatCostListener {
	reads(f: FlatContext, event: { holder: string; owner: string }): Record<string, D1PreparedStatement>;
	run(
		f: FlatContext,
		rows: Record<string, Record<string, unknown>[]>,
		event: { holder: string; owner: string; cost: Cost; purpose: SpendPurpose },
	): D1PreparedStatement[] | null;
}

/** What a flat spend needs, from the batch: the pool's rows, its numbers (derived) and the listeners' rows. */
export interface FlatPool {
	rows: Record<string, Record<string, unknown>[]>;
	numbers: unknown;
}

/** Upkeep per second by resource id for one holder (positive numbers = consumption). Must only read. */
export type Consumer = (api: ReadApi, holder: string) => Promise<Record<string, number>>;

/**
 * Maps request/command params to the holder the acting player may use (e.g. validates
 * `settlement` belongs to them, defaults to their capital). Throws `GameError` otherwise.
 */
export type HolderResolver = (api: EngineApi, params: ViewParams) => Promise<string>;

export type { ProductionRow };

export interface ResourcesService {
	define(def: ResourceDef): void;
	/** Define resources from a CSV table with columns id, name, icon, initial (see kernel/data.ts). */
	defineFromCsv(csv: string): void;
	list(): readonly ResourceDef[];
	/** How many times `stock` pays `cost` (whole; Infinity when nothing is to pay), e.g. a form's "at most". */
	timesPaid(cost: Cost, stock: Record<string, number>): number;
	addProducer(producer: Producer): void;
	/** Register upkeep (e.g. garrisoned troops). Not affected by production bonuses. Settle the holder before upkeep changes. */
	/** Returns its id (for a flat command changing what it consumes: `flat.spend`'s `consumer`). */
	addConsumer(consumer: Consumer, source?: UiText): number;
	/**
	 * Production by resource as players read it (per second): raw output, each bonus by source (percents turned
	 * into amounts), each upkeep by source, and the net rate. Sources named alike are summed.
	 */
	productionTable(api: ReadApi, holder: string): Promise<Record<string, ProductionRow>>;
	/** Called when upkeep pushes a resource down to its floor (`-debtLimit`), at that moment. */
	onDepleted(listener: DepletedListener): void;
	/**
	 * Amounts as far as the pool has been advanced so far, without advancing it. Use this
	 * inside timeline handlers (the pool is at the event's time there); elsewhere use `amounts`.
	 */
	peekAmounts(api: ReadApi, holder: string): Promise<Record<string, number>>;
	/** Start reading these holders' pools, not awaited (a command's preload: `settlements.preload`). */
	preload(api: ReadApi, holders: string[]): void;
	/** True when the resource is at or below zero right now. */
	inDeficit(api: EngineApi, holder: string, resource: string): Promise<boolean>;
	/** `flat`: the holder the view's parameters name, without reading (for flat views; null: the regular resolver's). */
	setHolderResolver(resolver: HolderResolver, flat?: (params: ViewParams) => string | null): void;
	/**
	 * Whose a holder is (a player id; null: nobody's, e.g. an NPC camp): its production numbers are stored and read back
	 * while that player's tables they rest on are unchanged (`api.derived`). Default: "player:<id>" is that player's.
	 */
	setOwnerOf(ownerOf: (api: ReadApi, holder: string) => Promise<string | null>): void;
	/**
	 * Entities "<prefix>:<id>" hold resources (e.g. "settlement"). Once any kind is registered, the
	 * timeline only settles pools of those kinds while advancing an entity (an army has no pool).
	 */
	addHolderKind(prefix: string): void;
	resolveHolder(api: EngineApi, params: ViewParams): Promise<string>;
	/** Net rate per second: production x `resources.productionFactor` - upkeep. Can be negative. */
	rates(api: ReadApi, holder: string): Promise<Record<string, number>>;
	/** The parts of the net rate, for display. */
	/** `extra`: production per second from parts with their own percent bonus (beyond production x factor). */
	breakdown(
		api: ReadApi,
		holder: string,
	): Promise<{ production: Record<string, number>; factor: number; extra: Record<string, number>; upkeep: Record<string, number> }>;
	capacity(api: ReadApi, holder: string): Promise<number>;
	/** Current amounts (due timeline events processed first). Mutations in a command are reflected. */
	amounts(api: EngineApi, holder: string): Promise<Record<string, number>>;
	canAfford(api: EngineApi, holder: string, cost: Cost): Promise<boolean>;
	/** Credit elapsed production and persist the pool at commit. */
	settle(api: EngineApi, holder: string): Promise<void>;
	add(api: EngineApi, holder: string, id: string, delta: number): Promise<void>;
	/** Deducts `cost` or throws `GameError("insufficient_resources")` without changing anything. `purpose`: default "spend". */
	spend(api: EngineApi, holder: string, cost: Cost, purpose?: SpendPurpose): Promise<void>;
	/** Listen to `spend` (all purposes). */
	onSpent(listener: CostListener, flat?: FlatCostListener): void;
	/**
	 * Flat commands: a holder's pool. `derived` (the stored numbers to ask the engine for: valid only with nothing due),
	 * `reads` (the pool's rows and the spend listeners' reads, under `prefix`), and `spend`: the writes of spending `cost`
	 * as `spend` would make them, or null (cannot afford, a listener with no flat form, a server upgrade to catch up…).
	 */
	flat: {
		derived(holder: string): { key: string; salt: string };
		reads(f: FlatContext, holder: string, owner: string, prefix: string): Record<string, D1PreparedStatement>;
		spend(
			f: FlatContext,
			holder: string,
			owner: string,
			prefix: string,
			input: FlatPool,
			cost: Cost | { cost: Cost; purpose: SpendPurpose }[],
			options?: { consumer?: { id: number; value: Record<string, number> } },
		): D1PreparedStatement[] | null;
	};
	/** Give back part of what was spent (e.g. a cancelled construction) and tell `onRefunded` listeners. */
	refund(api: EngineApi, holder: string, cost: Cost): Promise<void>;
	/** Only tell `onRefunded` listeners: the resources come back some other way (e.g. carried home by a march). */
	refunded(api: EngineApi, holder: string, cost: Cost): Promise<void>;
	onRefunded(listener: CostListener): void;
}

declare module '../../kernel' {
	interface ServiceMap {
		resources: ResourcesService;
	}
}

const DEPLETED = 'resources.depleted';

// What a pool writes when a command is done (the settle flush, and `flat.spend` on the fast path).
/** Float noise (e.g. -1e-12 after spending everything) snapped to zero. */
const snap = (n: number) => (Math.abs(n) < 1e-9 ? 0 : n);
/**
 * The resources whose rows change: an amount that has not moved under the same rate is left (its time does not matter
 * at rate 0, and a moving one changes anyway), and so is no row still at the starting amount with no rate (a missing row
 * reads as exactly that, e.g. NPC camps). Most pools write nothing on most commands.
 */
const changedRows = (
	ids: Iterable<string>,
	amounts: Record<string, number>,
	rates: Record<string, number>,
	stored: (id: string) => { amount: number; rate: number } | undefined,
	start: Record<string, number>,
) =>
	[...ids].filter((id) => {
		const amount = snap(amounts[id]);
		const rate = rates[id] ?? 0;
		const was = stored(id);
		if (was) return was.rate !== rate || Math.abs(was.amount - amount) > 1e-9 || rate !== 0;
		return rate !== 0 || Math.abs(amount - (start[id] ?? 0)) > 1e-9;
	});
const UPSERT = `INSERT INTO resources_balances (holder, resource, amount, rate, updated_at) VALUES (?, ?, ?, ?, ?)
	ON CONFLICT (holder, resource) DO UPDATE SET amount = excluded.amount, rate = excluded.rate, updated_at = excluded.updated_at`;
/** When upkeep pushes each draining resource down to its floor (the debt limit below zero): its "depleted" events. */
const depletions = (
	ids: Iterable<string>,
	amounts: Record<string, number>,
	at: Record<string, number>,
	rates: Record<string, number>,
	debt: Record<string, number>,
) =>
	[...ids].flatMap((id) => {
		const rate = rates[id] ?? 0;
		const room = amounts[id] + (debt[id] ?? 0);
		return rate >= 0 || room <= 1e-9 ? [] : [{ resource: id, dueAt: at[id] + Math.ceil((room / -rate) * 1000) }];
	});

interface Pool {
	amounts: Record<string, number>;
	/** Time each amount is valid at. */
	at: Record<string, number>;
	/** What is stored now, by resource (none: no row, read as the starting amount): unchanged rows are not written again. */
	stored: Record<string, { amount: number; rate: number }>;
	/** When it was last written (its latest row; 0: never), as stored: what the view's stamp goes by. */
	settledAt: number;
}

export default definePlugin({
	id: 'resources',
	version: '0.4.0',
	description: 'Resource pools per holder (settlement), with capacity and lazy settlement',
	dependsOn: ['stats', 'timeline', 'ui', 'i18n'],
	tables: ['resources_balances'],
	setup(ctx) {
		// Other plugins' tables, for the lists below that name what is read on the way (not their names).
		const TIMELINE = ctx.tablesOf('timeline');
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const stats = ctx.services.get('stats');
		const timeline = ctx.services.get('timeline');
		const defs = new Map<string, ResourceDef>();
		const producers: Producer[] = [];
		const consumers: { fn: Consumer; source?: UiText }[] = [];
		const depletedListeners: DepletedListener[] = [];
		const spentListeners: CostListener[] = [];
		const flatSpent: (FlatCostListener | undefined)[] = [];
		const refundListeners: CostListener[] = [];
		let resolver: HolderResolver = async (api) => `player:${api.playerId}`;
		let flatHolder: (params: ViewParams) => string | null = () => null;

		const contentInitial = () => Object.fromEntries([...defs.values()].map((d) => [d.id, d.initial ?? 0]));
		const parseInitial = numberRecord(() => defs.keys(), 0, Number.MAX_VALUE);
		const initial = ctx.config.define('initial', {
			description:
				'Starting amount of each resource in a new pool (new settlement), e.g. {"food": 500}. Omitted resources keep the content default.',
			default: contentInitial,
			parse: (raw) => ({ ...contentInitial(), ...parseInitial(raw) }),
		});
		const debtLimit = ctx.config.define('debtLimit', {
			description:
				'How far upkeep may push each resource below zero, e.g. {"food": 100, "gold": 50}. Spending can never go below zero. Omitted resources: 0.',
			default: (): Record<string, number> => ({}),
			parse: numberRecord(() => defs.keys(), 0, 1e12),
		});
		const baseCapacity = ctx.config.define('baseCapacity', {
			description: 'Storage cap per resource before bonuses (warehouses etc. add to it).',
			default: () => RULES.baseCapacity as number,
			parse: numberInRange(0, 1e15),
		});
		stats.define({
			id: 'resources.productionFactor',
			description: 'production',
			// Contributors add percent bonuses, e.g. { percent: 10 } for +10% production.
			base: () => 1,
			min: 0,
		});
		stats.define({
			id: 'resources.capacity',
			description: 'storage cap',
			base: (api) => baseCapacity.get(api),
			min: 0,
		});

		const known = (id: string) => {
			if (!defs.has(id)) throw new PluginError(`Unknown resource "${id}"`);
		};

		async function workBreakdown(api: ReadApi, holder: string) {
			// Percent bonuses (research, items, events) multiply production, never upkeep. A part
			// with its own percent (terrain...) adds it to the general factor: 1 + all bonuses, at least 0.
			const factor = await stats.get(api, 'resources.productionFactor', holder);
			const production: Record<string, number> = {};
			const extra: Record<string, number> = {};
			// Per-resource bonuses (stat `resources.output.<id>`, 1 = none) add to the general factor too.
			const perResource: Record<string, number> = {};
			const ownOf = async (r: string) => (perResource[r] ??= defs.has(r) ? (await stats.get(api, outputStat(r), holder)) - 1 : 0);
			for (const source of producers) {
				for (const [r, p] of Object.entries(await source(api, holder))) {
					const bonus = await ownOf(r);
					for (const part of typeof p === 'number' ? [{ amount: p, percent: 0 }] : p) {
						production[r] = (production[r] ?? 0) + part.amount;
						const own = part.amount * Math.max(0, factor + bonus + part.percent / 100) - part.amount * factor;
						if (own) extra[r] = (extra[r] ?? 0) + own;
					}
				}
			}
			// Each consumer's upkeep apart too (in their order, summed as `sum` does): a flat command that changes one of them
			// (troops leaving) works the total out again the same way.
			const upkeepBy: Record<string, number>[] = [];
			for (const c of consumers) upkeepBy.push(await c.fn(api, holder));
			return { production, factor, extra, upkeep: sumUpkeep(upkeepBy), upkeepBy };
		}
		function sumUpkeep(parts: Record<string, number>[]) {
			const out: Record<string, number> = {};
			for (const part of parts) for (const [r, perSec] of Object.entries(part)) out[r] = (out[r] ?? 0) + perSec;
			return out;
		}

		/** See `ResourcesService.productionTable`: the same sums as `breakdown`, kept by source; `net` from them. */
		async function workTable(api: ReadApi, holder: string, net: Record<string, number>) {
			const other = text('Other');
			const out: Record<string, ProductionRow> = {};
			const rowOf = (r: string) => (out[r] ??= { raw: 0, bonuses: [], upkeep: [], net: 0 });
			const add = (list: { source: UiText; amount: number }[], source: UiText, amount: number) => {
				if (!amount) return;
				const key = JSON.stringify(source);
				const same = list.find((x) => JSON.stringify(x.source) === key);
				if (same) same.amount += amount;
				else list.push({ source, amount });
			};
			// A bonus of x% (or a flat 0.x on a factor of 1) adds x% of the raw output.
			const share = (p: { flat: number; percent: number }) => p.flat + p.percent / 100;
			const general = (await stats.breakdown(api, 'resources.productionFactor', holder)).parts;
			for (const source of producers) {
				for (const [r, p] of Object.entries(await source(api, holder))) {
					const row = rowOf(r);
					for (const part of typeof p === 'number' ? [{ amount: p, percent: 0 }] : p) {
						row.raw += part.amount;
						const named = 'sources' in part && part.sources ? part.sources : [];
						for (const s of named) add(row.bonuses, s.source, (part.amount * s.percent) / 100);
						const rest = part.percent - named.reduce((a, s) => a + s.percent, 0);
						if (rest) add(row.bonuses, other, (part.amount * rest) / 100);
					}
				}
			}
			for (const [r, row] of Object.entries(out)) {
				for (const g of general) add(row.bonuses, g.source, row.raw * share(g));
				if (defs.has(r))
					for (const g of (await stats.breakdown(api, outputStat(r), holder)).parts) add(row.bonuses, g.source, row.raw * share(g));
			}
			for (const c of consumers)
				for (const [r, perSec] of Object.entries(await c.fn(api, holder))) add(rowOf(r).upkeep, c.source ?? other, perSec);
			for (const [r, row] of Object.entries(out)) {
				row.net = net[r] ?? 0;
				// What the parts do not explain (a factor clamped at 0): shown as "Other" so the row adds up.
				const explained = row.raw + row.bonuses.reduce((a, b) => a + b.amount, 0) - row.upkeep.reduce((a, b) => a + b.amount, 0);
				if (Math.abs(row.net - explained) > 1e-9) add(row.bonuses, other, row.net - explained);
			}
			return out;
		}

		function ratesOf({
			production,
			factor,
			extra,
			upkeep,
		}: Pick<Awaited<ReturnType<typeof workBreakdown>>, 'production' | 'factor' | 'extra' | 'upkeep'>) {
			const out: Record<string, number> = {};
			for (const id of new Set([...Object.keys(production), ...Object.keys(upkeep)])) {
				const net = (production[id] ?? 0) * factor + (extra[id] ?? 0) - (upkeep[id] ?? 0);
				if (Math.abs(net) > 1e-12) out[id] = net;
			}
			return out;
		}

		/**
		 * Everything about a holder's production worked out at once (rates, their parts, the cap, the table by source and
		 * the hover texts), stored and read back while nothing it rests on changed (2026-10-19, user: "算好的产量、维持费、
		 * 上限，是不是应该存起来，只有变的时候才重算，其他时候只读？"): a dozen tables of other plugins read only after a
		 * change. Events due but not applied yet change it in memory first (the salt). Every change of production, upkeep
		 * or cap is a write to some table (settled first: a rule of this code base), which the kernel notices.
		 */
		let ownerOf = async (_api: ReadApi, holder: string): Promise<string | null> =>
			holder.startsWith('player:') ? holder.slice('player:'.length) : null;
		const numbers = async (api: ReadApi, holder: string) => {
			// How many events were due as stored (counted before they are applied: a view applies them in memory only), then
			// those applied, whoever asks first: the numbers are those after them (before, the production table of a page
			// could show a building its resource bar already counted). Not inside the holder's own events.
			const due = String(await timeline.due(api as EngineApi, holder));
			if (!timeline.syncing(api as EngineApi, holder)) await timeline.sync(api as EngineApi, holder);
			// "2|": the stored shape changed (the sources as data, 1.5.1): rows stored before are worked out again.
			// Not stale when only events or amounts are written (a construction scheduled, a cost paid): both are read on
			// the way by the sync (it advances the pool), but rates and caps come from what stands and what is known; how
			// many events are due is the salt.
			return derive(
				api,
				RATES.key(holder),
				{ owner: await ownerOf(api, holder), salt: RATES.salt(due), ignore: [...TIMELINE, 'resources_balances'] },
				async () => {
					const parts = await workBreakdown(api, holder);
					const net = ratesOf(parts);
					const cap = await stats.breakdown(api, 'resources.capacity', holder);
					const factor = await stats.breakdown(api, 'resources.productionFactor', holder);
					return {
						parts,
						rates: net,
						capacity: await stats.get(api, 'resources.capacity', holder),
						table: await workTable(api, holder, net),
						// Where the cap and the factor come from, as data: worded in the browser (src/shared/stats.ts).
						sources: { capacityBreakdown: { base: cap.base, parts: cap.parts }, factorParts: factor.parts },
					};
				},
			);
		};
		type NumbersRow = Awaited<ReturnType<typeof numbers>>;
		const breakdown = async (api: ReadApi, holder: string) => (await numbers(api, holder)).parts;
		const rates = async (api: ReadApi, holder: string) => (await numbers(api, holder)).rates;
		const capacity = async (api: ReadApi, holder: string) => (await numbers(api, holder)).capacity;
		const productionTable = async (api: ReadApi, holder: string) => (await numbers(api, holder)).table;

		/** Raw pool as stored (no time advanced). */
		const loadPool = (api: ReadApi, holder: string) =>
			api.memo(
				`resources:pool:${holder}`,
				async (): Promise<Pool> => {
					const { results } = api.isFresh(holder)
						? { results: [] as { resource: string; amount: number; rate: number; updated_at: number }[] }
						: await api.db
								.prepare('SELECT resource, amount, rate, updated_at FROM resources_balances WHERE holder = ?')
								.bind(holder)
								.all<{ resource: string; amount: number; rate: number; updated_at: number }>();
					const rows = new Map(results.map((r) => [r.resource, r]));
					const start = initial.get(api);
					const pool: Pool = {
						amounts: {},
						at: {},
						stored: Object.fromEntries(results.map((r) => [r.resource, { amount: r.amount, rate: r.rate }])),
						settledAt: Math.max(0, ...results.map((r) => r.updated_at)),
					};
					for (const id of defs.keys()) {
						const row = rows.get(id);
						pool.amounts[id] = row ? row.amount : (start[id] ?? 0);
						pool.at[id] = row ? row.updated_at : api.now;
					}
					await catchUp(api, holder, pool);
					return pool;
				},
				{ current: true },
			);

		/**
		 * After a server upgrade, what accrued before it is worked out at the rules of the time (1.4.1, user 2026-10-19:
		 * "服务器升级时，先按之前的规则结算后，再按新规则运行。"): amounts last settled before the upgrade are advanced to it
		 * at the old rates and capacity, then go on from there as usual (the next commit writes them). Only pools not
		 * touched since the upgrade pay for this, once.
		 */
		async function catchUp(api: ReadApi, holder: string, pool: Pool) {
			const at = api.upgrade?.at;
			const windowStart = api.now - (api.config[MAX_OFFLINE_SECONDS_KEY] as number) * 1000;
			// Only time inside the offline window counts: an upgrade before it changes nothing (no old rules read).
			if (at === undefined || at <= windowStart || !Object.values(pool.at).some((t) => t < at)) return;
			const before = await api.beforeUpgrade();
			if (!before) return;
			const r = await rates(before, holder);
			const cap = await capacity(before, holder);
			const debt = debtLimit.get(before);
			for (const id of defs.keys()) {
				if (pool.at[id] >= at) continue;
				const seconds = (at - Math.max(pool.at[id], windowStart)) / 1000;
				const rate = r[id] ?? 0;
				const amount = pool.amounts[id];
				if (seconds > 0 && rate !== 0)
					pool.amounts[id] =
						rate > 0
							? amount >= cap
								? amount
								: Math.min(cap, amount + rate * seconds)
							: Math.min(amount, Math.max(-(debt[id] ?? 0), amount + rate * seconds));
				pool.at[id] = at;
			}
		}

		/** Advance a pool to time `t` under the current rates/capacity (never backwards). */
		async function advanceTo(api: EngineApi, holder: string, t: number) {
			const pool = await loadPool(api, holder);
			const r = await rates(api, holder);
			const cap = await capacity(api, holder);
			const debt = debtLimit.get(api);
			// Production only counts within the offline window ending at the real "now".
			const windowStart = api.now - (api.config[MAX_OFFLINE_SECONDS_KEY] as number) * 1000;
			for (const id of defs.keys()) {
				const from = Math.max(pool.at[id], windowStart);
				const seconds = (t - from) / 1000;
				const rate = r[id] ?? 0;
				if (seconds > 0 && rate !== 0) {
					const amount = pool.amounts[id];
					// Growth stops at the cap (an amount already above it is kept); upkeep may dig
					// below zero down to the debt limit, where it stops.
					pool.amounts[id] =
						rate > 0
							? amount >= cap
								? amount
								: Math.min(cap, amount + rate * seconds)
							: Math.min(amount, Math.max(-(debt[id] ?? 0), amount + rate * seconds));
				}
				pool.at[id] = Math.max(pool.at[id], t);
			}
			return pool;
		}

		timeline.on<{ resource: string }>(DEPLETED, async (api, event) => {
			for (const listener of depletedListeners)
				await listener(api, { holder: event.entity, resource: event.payload.resource, at: event.dueAt });
		});

		const holderKinds = new Set<string>();
		timeline.onAdvance(async (api, entity, t) => {
			if (holderKinds.size && !holderKinds.has(entity.slice(0, entity.indexOf(':')))) return;
			await advanceTo(api, entity, t);
			await service.settle(api, entity);
		});

		interface PoolRow {
			resource: string;
			amount: number;
			rate: number;
			updated_at: number;
		}
		/**
		 * A pool's amounts at `f.now` from its stored rows (for flat forms), as `advanceTo` works them out: growth up to the
		 * cap, upkeep down to the debt limit, inside the offline window. Null: settled before a server upgrade inside the
		 * window (the old rules' catch-up is the regular path's).
		 */
		function advancedFrom(f: FlatContext, rows: PoolRow[], rates: Record<string, number>, cap: number) {
			const start = initial.get(f);
			const debt = debtLimit.get(f);
			const windowStart = f.now - (f.config[MAX_OFFLINE_SECONDS_KEY] as number) * 1000;
			const stored = new Map(rows.map((x) => [x.resource, x]));
			const amounts: Record<string, number> = {};
			const at: Record<string, number> = {};
			for (const id of defs.keys()) {
				const row = stored.get(id);
				amounts[id] = row ? row.amount : (start[id] ?? 0);
				at[id] = row ? row.updated_at : f.now;
				if (f.upgradeAt !== undefined && f.upgradeAt > windowStart && at[id] < f.upgradeAt) return null;
			}
			for (const id of defs.keys()) {
				const seconds = (f.now - Math.max(at[id], windowStart)) / 1000;
				const rate = rates[id] ?? 0;
				if (seconds > 0 && rate !== 0) {
					const amount = amounts[id];
					amounts[id] =
						rate > 0
							? amount >= cap
								? amount
								: Math.min(cap, amount + rate * seconds)
							: Math.min(amount, Math.max(-(debt[id] ?? 0), amount + rate * seconds));
				}
				at[id] = Math.max(at[id], f.now);
			}
			return { amounts, at, stored, start, debt };
		}
		const service: ResourcesService = {
			timesPaid: (cost, stock) =>
				Math.min(Infinity, ...Object.entries(cost).map(([r, n]) => (n > 0 ? Math.floor(Math.max(0, stock[r] ?? 0) / n) : Infinity))),
			define(def) {
				if (defs.has(def.id)) throw new PluginError(`Resource "${def.id}" defined twice`);
				// Names are i18n keys of the plugin defining them.
				def = { ...def, name: ctx.services.get('i18n').own(def.name) };
				defs.set(def.id, def);
				// Bonus for this resource only (e.g. irrigation: food), on top of the general factor.
				stats.define({ id: outputStat(def.id), description: text('{0} production', { 0: keyText(def.name) }), base: () => 1, min: 0 });
			},
			list: () => [...defs.values()],
			addHolderKind: (prefix) => void holderKinds.add(prefix),
			defineFromCsv(csv) {
				for (const row of csvRows(csv))
					service.define({ id: row.id, name: row.name, icon: row.icon || undefined, initial: csvNumber(row, 'initial', 0) });
			},
			addProducer: (p) => void producers.push(p),
			addConsumer: (fn, source) => consumers.push({ fn, ...(source ? { source } : {}) }) - 1,
			productionTable: (api, holder) => productionTable(api, holder),
			onDepleted: (l) => void depletedListeners.push(l),
			peekAmounts: async (api, holder) => (await loadPool(api, holder)).amounts,
			preload: (api, holders) => holders.forEach((h) => void loadPool(api, h).catch(() => {})),
			async inDeficit(api, holder, resource) {
				return ((await service.amounts(api, holder))[resource] ?? 0) <= 0;
			},
			breakdown,
			setHolderResolver(r, flat) {
				resolver = r;
				flatHolder = flat ?? (() => null);
			},
			resolveHolder: (api, params) => resolver(api, params),
			setOwnerOf(fn) {
				ownerOf = fn;
			},
			rates,
			capacity,

			async amounts(api, holder) {
				await timeline.sync(api, holder);
				return (await advanceTo(api, holder, api.now)).amounts;
			},

			async canAfford(api, holder, cost) {
				const amounts = await service.amounts(api, holder);
				return Object.entries(cost).every(([id, n]) => (amounts[id] ?? 0) >= n);
			},

			async settle(api, holder) {
				// Bank what the current rates produced up to now, before the caller changes them.
				// Inside the holder's own timeline events the clock is already at the event time.
				if (!timeline.syncing(api, holder)) {
					await timeline.sync(api, holder);
					await advanceTo(api, holder, api.now);
				} else await loadPool(api, holder);
				// Last: after the others' writes (equipment totals, prestige...), the rates stored and predicted with are those
				// of everything this command changed.
				api.beforeCommit(
					`resources:flush:${holder}`,
					async () => {
						const pool = await advanceTo(api, holder, api.now);
						// Rates after this command's changes, stored only for GM report estimates.
						const r = await rates(api, holder);
						const changed = changedRows(defs.keys(), pool.amounts, r, (id) => pool.stored[id], initial.get(api));
						if (!changed.length) return;
						// The views after this command see the pool as written (their stamp moves on with it).
						pool.settledAt = Math.max(pool.settledAt, ...changed.map((id) => pool.at[id]));
						api.write(
							...changed.map((id) => {
								const amount = snap(pool.amounts[id]);
								pool.stored[id] = { amount, rate: r[id] ?? 0 };
								return api.db.prepare(UPSERT).bind(holder, id, amount, r[id] ?? 0, pool.at[id]);
							}),
						);
						// Rates may have changed: re-predict when upkeep will drain each resource (a new pool has none to drop).
						if (!api.isFresh(holder)) timeline.cancelLater(api, holder, DEPLETED);
						for (const { resource, dueAt } of depletions(defs.keys(), pool.amounts, pool.at, r, debtLimit.get(api)))
							if (dueAt > api.now) timeline.schedule(api, holder, dueAt, DEPLETED, { resource });
					},
					{ last: true, writes: ['resources_balances', ...TIMELINE] },
				);
			},

			async add(api, holder, id, delta) {
				known(id);
				const amounts = await service.amounts(api, holder);
				await service.settle(api, holder);
				amounts[id] = (amounts[id] ?? 0) + delta;
			},

			async spend(api, holder, cost, purpose = 'spend') {
				for (const id of Object.keys(cost)) known(id);
				if (!(await service.canAfford(api, holder, cost))) throw fail('insufficient_resources', 'Not enough resources');
				for (const [id, n] of Object.entries(cost)) await service.add(api, holder, id, -n);
				for (const l of spentListeners) await l(api, { holder, cost, purpose });
			},
			onSpent(l, flat) {
				spentListeners.push(l);
				flatSpent.push(flat);
			},
			flat: {
				derived: (holder) => RATES.wanted(holder),
				reads(f, holder, owner, prefix) {
					const out: Record<string, D1PreparedStatement> = {
						[`${prefix}pool`]: f.db
							.prepare('SELECT resource, amount, rate, updated_at FROM resources_balances WHERE holder = ?')
							.bind(holder),
					};
					flatSpent.forEach((l, i) => {
						if (!l) return;
						Object.assign(out, prefixed(`${prefix}l${i}:`, l.reads(f, { holder, owner })));
					});
					return out;
				},
				spend(f, holder, owner, prefix, input, costs, options) {
					if (flatSpent.some((l) => !l)) return null;
					const parts = Array.isArray(costs) ? costs : [{ cost: costs, purpose: 'spend' as SpendPurpose }];
					const total: Cost = {};
					for (const { cost } of parts)
						for (const [id, n] of Object.entries(cost)) {
							if (!defs.has(id)) return null;
							total[id] = (total[id] ?? 0) + n;
						}
					const numbers = input.numbers as {
						rates: Record<string, number>;
						capacity: number;
						parts: Parameters<typeof ratesOf>[0] & { upkeepBy?: Record<string, number>[] };
					};
					const { rates: r, capacity: cap } = numbers;
					// After this command: one consumer's upkeep changed (e.g. troops left), the rates worked out again as the
					// stored ones were (the consumers' parts summed in their order).
					let after = r;
					if (options?.consumer) {
						const by = numbers.parts.upkeepBy;
						const { id, value } = options.consumer;
						if (!by || !(id in by)) return null;
						after = ratesOf({ ...numbers.parts, upkeep: sumUpkeep(by.map((x, i) => (i === id ? value : x))) });
					}
					const rows = input.rows[`${prefix}pool`] as unknown as PoolRow[];
					const advanced = advancedFrom(f, rows, r, cap);
					if (!advanced) return null;
					const { amounts, at, stored, start, debt } = advanced;
					if (!Object.entries(total).every(([id, n]) => (amounts[id] ?? 0) >= n)) return null;
					const writes: D1PreparedStatement[] = [];
					// Each part as `spend` takes it: paid, then its listeners told (they write at commit).
					for (const { cost, purpose } of parts) {
						for (const [id, n] of Object.entries(cost)) amounts[id] = (amounts[id] ?? 0) - n;
						for (let i = 0; i < flatSpent.length; i++) {
							const w = flatSpent[i]!.run(f, flatPart(input.rows, `${prefix}l${i}:`), { holder, owner, cost, purpose });
							if (w === null) return null;
							writes.push(...w);
						}
					}
					// As the settle flush: only rows that change, then upkeep's next "depleted" events predicted again.
					const changed = changedRows(defs.keys(), amounts, after, (id) => stored.get(id), start);
					if (!changed.length) return writes;
					for (const id of changed) writes.push(f.db.prepare(UPSERT).bind(holder, id, snap(amounts[id]), after[id] ?? 0, at[id]));
					writes.push(timeline.flatCancelLater(f, holder, DEPLETED));
					for (const { resource, dueAt } of depletions(defs.keys(), amounts, at, after, debt))
						if (dueAt > f.now) writes.push(timeline.flatSchedule(f, holder, dueAt, DEPLETED, { resource }, owner));
					return writes;
				},
			},
			async refund(api, holder, cost) {
				for (const [id, n] of Object.entries(cost)) if (n > 0) await service.add(api, holder, id, n);
				await service.refunded(api, holder, cost);
			},
			async refunded(api, holder, cost) {
				for (const l of refundListeners) await l(api, { holder, cost, purpose: 'spend' });
			},
			onRefunded: (l) => void refundListeners.push(l),
		};

		ctx.services.provide('resources', service);
		ctx.meta.add('resources', () => service.list());

		/**
		 * What the pool view (and others showing its rates) goes by: every change of production, upkeep or cap settles the
		 * pool first (a rule of this code base), which writes it; so when it was last written, the rules' version, and how
		 * many of its events are due but not yet written.
		 */

		ctx.views.add({
			id: 'resources.pool',
			quiet: true,
			/*
			 * Not sent again while nothing changed it (user 2026-10-05: "城池的资源总数都不用同步，因为客户端和服务端各算各的就行。
			 * 只有产量变化……或消耗事件发生时才重新同步资源总量。"): the client counts on from `at` with the rates and the cap. Every
			 * change of production, upkeep or cap settles the pool first (a rule of this code base), which writes it; so the
			 * stamp is when it was last written, the rules' version, and how many of its events are due but not yet written.
			 */
			// Stamped by what it read (as `poolStamp` was, its events due aside: while some are, it is worked out). Flat
			// (docs/development.md §2.3 "扁平视图"): the pool's rows and its stored numbers, the amounts counted on to now
			// as the rows are counted on everywhere; the holder the parameters name (its numbers are stored per owner: another
			// player's settlement finds none, and the regular compute answers).
			flat: {
				derived: (_f, params) => {
					const holder = flatHolder(params);
					return holder ? [service.flat.derived(holder)] : [];
				},
				reads: (f, params): Record<string, D1PreparedStatement> => {
					const holder = flatHolder(params);
					return holder
						? { pool: f.db.prepare('SELECT resource, amount, rate, updated_at FROM resources_balances WHERE holder = ?').bind(holder) }
						: {};
				},
				build(f): ResourcePool | undefined {
					const holder = flatHolder(f.payload);
					const numbers = holder ? (f.derived[service.flat.derived(holder).key] as NumbersRow | undefined) : undefined;
					if (!holder || !numbers) return undefined;
					const advanced = advancedFrom(f, f.rows.pool as unknown as PoolRow[], numbers.rates, numbers.capacity);
					if (!advanced) return undefined;
					const { production, factor, extra, upkeep } = numbers.parts;
					return {
						holder,
						at: f.now,
						amounts: advanced.amounts,
						rates: numbers.rates,
						production,
						factor,
						extra,
						upkeep,
						debtLimit: debtLimit.get(f),
						capacity: numbers.capacity,
						...numbers.sources,
					};
				},
			},
			async compute(api, params): Promise<ResourcePool | null> {
				let holder: string;
				try {
					holder = await resolver(api, params);
				} catch (err) {
					// No settlement yet (e.g. an account older than the city system): nothing to show,
					// but the rest of the state must still load so the player can found a capital.
					if (err instanceof GameError && err.code === 'no_settlement') return null;
					throw err;
				}
				const amounts = await service.amounts(api, holder);
				const { production, factor, extra, upkeep } = await breakdown(api, holder);
				return {
					holder,
					at: api.now,
					amounts,
					rates: await rates(api, holder),
					production,
					factor,
					extra,
					upkeep,
					debtLimit: debtLimit.get(api),
					capacity: await service.capacity(api, holder),
					...(await sources(api, holder)),
				};
			},
		});

		/** The cap and the production factor by source, for hover text (the browser words them). */
		const sources = async (api: ReadApi, holder: string) => (await numbers(api, holder)).sources;

		ctx.commands.add<{ resource: string; amount: number; settlement?: string }>({
			type: 'resources.grant',
			privileged: true,
			form: {
				title: text('Grant resources'),
				placement: 'gm',
				fields: [
					{ name: 'settlement', label: text('Settlement'), type: 'select', required: true },
					{ name: 'resource', label: text('Resource'), type: 'select', required: true },
					{ name: 'amount', label: text('Amount (negative to take)'), type: 'number', required: true, default: 1000 },
				],
				submitLabel: text('Grant'),
				async prepare(api) {
					const settlements = ctx.services.has('settlements') ? ctx.services.get('settlements') : null;
					const s = settlements ? await settlements.mine(api, api.playerId) : [];
					return {
						options: {
							settlement: s.map((x) => ({ value: x.id, label: settlements!.nameText(x), at: { x: x.x, y: x.y } })),
							resource: [...defs.values()].map((d) => ({ value: d.id, label: keyText(d.name) })),
						},
					};
				},
			},
			description:
				'Add (or with a negative amount, remove) a resource; ignores the storage cap. Payload: { "resource": "food", "amount": 1000, "settlement": "<id, default capital>" }',
			parse: shape({
				resource: fields.oneOf(() => [...defs.keys()]),
				amount: fields.number(-1e15, 1e15),
				settlement: fields.optional(fields.id()),
			}),
			async execute(api, { resource, amount, settlement }) {
				const holder = await resolver(api, settlement ? { settlement } : {});
				const amounts = await service.amounts(api, holder);
				await service.add(api, holder, resource, amount < 0 ? Math.max(amount, -Math.max(0, amounts[resource] ?? 0)) : amount);
			},
		});

		// GM reports. Amounts are estimated in SQL from the last settle (ignoring capacity and
		// rule changes since); `holder` is the pool owner, e.g. "settlement:<id>".
		const estimate = 'amount + rate * MIN(MAX(0, (?1 - updated_at) / 1000.0), ?2)';
		ctx.reports.add({
			id: 'resources.top',
			description: 'Pools with the most of a resource (estimated now), optionally at least `min`.',
			example: { resource: 'food', min: 0, limit: 20 },
			async run(api, params) {
				const { resource, min, limit } = shape({
					resource: fields.oneOf(() => [...defs.keys()]),
					min: fields.orElse(fields.number(0, Number.MAX_VALUE), 0),
					limit: fields.orElse(fields.int(1, 500), 20),
				})(params);
				const { results } = await api.db
					.prepare(
						`SELECT holder, ${estimate} AS amount, rate AS perSecond FROM resources_balances
						 WHERE resource = ?3 AND ${estimate} >= ?4 ORDER BY amount DESC LIMIT ?5`,
					)
					.bind(api.now, api.config[MAX_OFFLINE_SECONDS_KEY], resource, min, Math.floor(limit))
					.all();
				return results;
			},
		});
		ctx.reports.add({
			id: 'resources.totals',
			description: 'Economy overview: per resource, number of pools, total and average (estimated now).',
			example: {},
			async run(api) {
				const { results } = await api.db
					.prepare(
						`SELECT resource, COUNT(*) AS pools, SUM(${estimate}) AS total, AVG(${estimate}) AS average, SUM(rate) AS totalPerSecond
						 FROM resources_balances GROUP BY resource ORDER BY resource`,
					)
					.bind(api.now, api.config[MAX_OFFLINE_SECONDS_KEY])
					.all();
				return results;
			},
		});

		// The settlement's production by source: the City page's table (`resources.production`) is assembled from it in
		// the browser. Sent again only when the pool's rates change (its stamp); the stock is counted on by the client.
		ctx.views.add({
			id: 'resources.sources',
			quiet: true,
			// Stamped by what it read; flat: the table as stored with the numbers (docs/development.md §2.3 "扁平视图").
			flat: {
				derived: (_f, params) => {
					const holder = flatHolder(params);
					return holder ? [service.flat.derived(holder)] : [];
				},
				reads: () => ({}),
				build(f) {
					const holder = flatHolder(f.payload);
					return holder ? (f.derived[service.flat.derived(holder).key] as NumbersRow | undefined)?.table : undefined;
				},
			},
			async compute(api, params): Promise<ProductionRows | null> {
				let holder: string;
				try {
					holder = await resolver(api, params);
				} catch (err) {
					if (err instanceof GameError && err.code === 'no_settlement') return null;
					throw err;
				}
				return productionTable(api, holder);
			},
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.band({ band: 'bottom', widget: 'resources.bar' });
		ui.block({ page: 'city', column: 'left', widget: 'ui.table', order: 15, props: { view: 'resources.production' } });
	},
});
