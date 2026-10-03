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
	type EngineApi,
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
} from '../../kernel';
import type { ResourcePool } from '../../shared/api';
import type { TableData, UiText } from '../../shared/ui';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { amount, signed, whole } from '../../shared/format';
import { keyText, literal, uiTexts } from '../../shared/i18n';

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

/** Upkeep per second by resource id for one holder (positive numbers = consumption). Must only read. */
export type Consumer = (api: ReadApi, holder: string) => Promise<Record<string, number>>;

/**
 * Maps request/command params to the holder the acting player may use (e.g. validates
 * `settlement` belongs to them, defaults to their capital). Throws `GameError` otherwise.
 */
export type HolderResolver = (api: EngineApi, params: ViewParams) => Promise<string>;

/** One resource's production by source (`productionTable`), per second. */
export interface ProductionRow {
	raw: number;
	bonuses: { source: UiText; amount: number }[];
	upkeep: { source: UiText; amount: number }[];
	net: number;
}

export interface ResourcesService {
	define(def: ResourceDef): void;
	/** Define resources from a CSV table with columns id, name, icon, initial (see kernel/data.ts). */
	defineFromCsv(csv: string): void;
	list(): readonly ResourceDef[];
	addProducer(producer: Producer): void;
	/** Register upkeep (e.g. garrisoned troops). Not affected by production bonuses. Settle the holder before upkeep changes. */
	addConsumer(consumer: Consumer, source?: UiText): void;
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
	/** True when the resource is at or below zero right now. */
	inDeficit(api: EngineApi, holder: string, resource: string): Promise<boolean>;
	setHolderResolver(resolver: HolderResolver): void;
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
	onSpent(listener: CostListener): void;
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

interface Pool {
	amounts: Record<string, number>;
	/** Time each amount is valid at. */
	at: Record<string, number>;
}

export default definePlugin({
	id: 'resources',
	version: '0.4.0',
	description: 'Resource pools per holder (settlement), with capacity and lazy settlement',
	dependsOn: ['stats', 'timeline', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const stats = ctx.services.get('stats');
		const timeline = ctx.services.get('timeline');
		const defs = new Map<string, ResourceDef>();
		const producers: Producer[] = [];
		const consumers: { fn: Consumer; source?: UiText }[] = [];
		const depletedListeners: DepletedListener[] = [];
		const spentListeners: CostListener[] = [];
		const refundListeners: CostListener[] = [];
		let resolver: HolderResolver = async (api) => `player:${api.playerId}`;

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

		async function sum(sources: { fn: Consumer }[], api: ReadApi, holder: string) {
			const out: Record<string, number> = {};
			for (const source of sources) {
				for (const [r, perSec] of Object.entries(await source.fn(api, holder))) out[r] = (out[r] ?? 0) + perSec;
			}
			return out;
		}

		async function breakdown(api: ReadApi, holder: string) {
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
			return { production, factor, extra, upkeep: await sum(consumers, api, holder) };
		}

		/** See `ResourcesService.productionTable`: the same sums as `breakdown`, kept by source. */
		async function productionTable(api: ReadApi, holder: string) {
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
			const net = await rates(api, holder);
			for (const [r, row] of Object.entries(out)) {
				row.net = net[r] ?? 0;
				// What the parts do not explain (a factor clamped at 0): shown as "Other" so the row adds up.
				const explained = row.raw + row.bonuses.reduce((a, b) => a + b.amount, 0) - row.upkeep.reduce((a, b) => a + b.amount, 0);
				if (Math.abs(row.net - explained) > 1e-9) add(row.bonuses, other, row.net - explained);
			}
			return out;
		}

		async function rates(api: ReadApi, holder: string) {
			const { production, factor, extra, upkeep } = await breakdown(api, holder);
			const out: Record<string, number> = {};
			for (const id of new Set([...Object.keys(production), ...Object.keys(upkeep)])) {
				const net = (production[id] ?? 0) * factor + (extra[id] ?? 0) - (upkeep[id] ?? 0);
				if (Math.abs(net) > 1e-12) out[id] = net;
			}
			return out;
		}

		/** Raw pool as stored (no time advanced). */
		const loadPool = (api: ReadApi, holder: string) =>
			api.memo(`resources:pool:${holder}`, async (): Promise<Pool> => {
				const { results } = await api.db
					.prepare('SELECT resource, amount, updated_at FROM resources_balances WHERE holder = ?')
					.bind(holder)
					.all<{ resource: string; amount: number; updated_at: number }>();
				const rows = new Map(results.map((r) => [r.resource, r]));
				const start = initial.get(api);
				const pool: Pool = { amounts: {}, at: {} };
				for (const id of defs.keys()) {
					const row = rows.get(id);
					pool.amounts[id] = row ? row.amount : (start[id] ?? 0);
					pool.at[id] = row ? row.updated_at : api.now;
				}
				return pool;
			});

		/** Advance a pool to time `t` under the current rates/capacity (never backwards). */
		async function advanceTo(api: EngineApi, holder: string, t: number) {
			const pool = await loadPool(api, holder);
			const r = await rates(api, holder);
			const cap = await stats.get(api, 'resources.capacity', holder);
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

		const service: ResourcesService = {
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
			addConsumer: (fn, source) => void consumers.push({ fn, ...(source ? { source } : {}) }),
			productionTable: (api, holder) => productionTable(api, holder),
			onDepleted: (l) => void depletedListeners.push(l),
			peekAmounts: async (api, holder) => (await loadPool(api, holder)).amounts,
			async inDeficit(api, holder, resource) {
				return ((await service.amounts(api, holder))[resource] ?? 0) <= 0;
			},
			breakdown,
			setHolderResolver(r) {
				resolver = r;
			},
			resolveHolder: (api, params) => resolver(api, params),
			rates,
			capacity: (api, holder) => stats.get(api, 'resources.capacity', holder),

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
				api.beforeCommit(`resources:flush:${holder}`, async () => {
					const pool = await advanceTo(api, holder, api.now);
					// Rates after this command's changes, stored only for GM report estimates.
					const r = await rates(api, holder);
					api.write(
						...[...defs.keys()].map((id) =>
							api.db
								.prepare(
									`INSERT INTO resources_balances (holder, resource, amount, rate, updated_at) VALUES (?, ?, ?, ?, ?)
									 ON CONFLICT (holder, resource) DO UPDATE SET amount = excluded.amount, rate = excluded.rate, updated_at = excluded.updated_at`,
								)
								// Snap float noise (e.g. -1e-12 after spending everything) to zero.
								.bind(holder, id, Math.abs(pool.amounts[id]) < 1e-9 ? 0 : pool.amounts[id], r[id] ?? 0, pool.at[id]),
						),
					);
					// Rates may have changed: re-predict when upkeep will drain each resource.
					api.write(
						api.db.prepare('DELETE FROM timeline_events WHERE entity = ? AND type = ? AND due_at > ?').bind(holder, DEPLETED, api.now),
					);
					// "Depleted" = upkeep has pushed it down to its floor (the debt limit below zero).
					const debt = debtLimit.get(api);
					for (const id of defs.keys()) {
						const rate = r[id] ?? 0;
						const room = pool.amounts[id] + (debt[id] ?? 0);
						if (rate >= 0 || room <= 1e-9) continue;
						const dueAt = pool.at[id] + Math.ceil((room / -rate) * 1000);
						if (dueAt > api.now) timeline.schedule(api, holder, dueAt, DEPLETED, { resource: id });
					}
				});
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
			onSpent: (l) => void spentListeners.push(l),
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

		ctx.views.add({
			id: 'resources.pool',
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

		/** The cap and the production factor by source, for hover text. */
		async function sources(api: ReadApi, holder: string) {
			const cap = await stats.breakdown(api, 'resources.capacity', holder);
			const factor = await stats.breakdown(api, 'resources.productionFactor', holder);
			return {
				capacitySources: stats.describe(cap.parts, { base: cap.base }),
				factorSources: stats.describe(factor.parts, { flatAsPercent: true }),
			};
		}

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
							settlement: s.map((x) => ({ value: x.id, label: text('{0} ({1}, {2})', { 0: settlements!.nameText(x), 1: x.x, 2: x.y }) })),
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

		// The settlement's production, a row per resource (per hour: the per-second numbers are too small to read).
		ctx.views.add({
			id: 'resources.production',
			async compute(api, params): Promise<TableData | null> {
				let holder: string;
				try {
					holder = await resolver(api, params);
				} catch (err) {
					if (err instanceof GameError && err.code === 'no_settlement') return null;
					throw err;
				}
				const table = await productionTable(api, holder);
				const have = await service.amounts(api, holder);
				const cap = await service.capacity(api, holder);
				const decimals = (n: number) => (Math.abs(n * 3600) < 100 ? 1 : 0);
				const hourly = (n: number) => amount(n * 3600, decimals(n));
				const change = (n: number) => signed(n * 3600, false, decimals(n));
				const bySource = (list: { source: UiText; amount: number }[], sign: 1 | -1) =>
					list.map((x) => text('{0} {1}/h', { 0: x.source, 1: change(sign * x.amount) }));
				const rows = [...defs.values()].map((def) => {
					const row = table[def.id] ?? { raw: 0, bonuses: [], upkeep: [], net: 0 };
					const bonus = row.bonuses.reduce((a, b) => a + b.amount, 0);
					const upkeep = row.upkeep.reduce((a, b) => a + b.amount, 0);
					// At the cap nothing more comes in: only the net column says so.
					const full = row.net > 0 && (have[def.id] ?? 0) >= cap;
					return {
						id: def.id,
						cells: [
							{ text: text('{0} {1}', { 0: def.icon ?? '', 1: keyText(def.name) }) },
							{ text: literal(whole(have[def.id] ?? 0)), ...((have[def.id] ?? 0) < 0 ? { tone: 'warn' as const } : {}) },
							full
								? { text: text('Full'), tone: 'warn' as const }
								: { text: literal(change(row.net)), ...(row.net < 0 ? { tone: 'warn' as const } : {}) },
							{ text: literal(hourly(row.raw)) },
							{
								text: literal(bonus ? change(bonus) : '—'),
								...(row.bonuses.length ? { hint: bySource(row.bonuses, 1) } : {}),
							},
							{
								text: literal(upkeep ? change(-upkeep) : '—'),
								...(row.upkeep.length ? { hint: bySource(row.upkeep, -1) } : {}),
							},
						],
					};
				});
				return {
					title: text('Production'),
					columns: [text('Resource'), text('Stock'), text('Net /h'), text('Output'), text('Bonuses'), text('Upkeep')],
					rows,
					lines: [{ text: text('Per hour. Hover a bonus or upkeep for where it comes from.'), tone: 'muted' }],
				};
			},
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.band({ band: 'bottom', widget: 'resources.bar' });
		ui.block({ page: 'city', column: 'left', widget: 'ui.table', order: 15, props: { view: 'resources.production' } });
	},
});
