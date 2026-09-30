/**
 * Troops: unit types, training, garrisons and their upkeep.
 *
 * Units are trained in batches (one batch at a time per settlement, finished by the
 * timeline) in settlements whose kind allows a garrison. Every garrisoned unit costs
 * upkeep per second, registered as a resources consumer — so an army that outgrows its
 * economy drains the pool and triggers the deficit reactions (see `onDeficit` below and
 * the `resources.depleted` event).
 */
import { definePlugin, GameError, numberInRange, PluginError, type EngineApi, type ReadApi } from '../../kernel';
import type { GarrisonInfo } from '../../shared/api';
import type { Cost } from '../resources';
import type { Settlement } from '../settlements';

export interface UnitDef {
	id: string;
	name: string;
	icon?: string;
	/** Cost per unit. */
	cost: Cost;
	/** Training time per unit, in seconds (before `troops.speed`). */
	seconds: number;
	/** Upkeep per unit per second, by resource. */
	upkeep: Record<string, number>;
	attack: number;
	defense: number;
	/** Marching speed in tiles per hour. */
	speed: number;
	/** Loot each unit can carry home. */
	carry: number;
	/** Building needed in the training settlement, e.g. { building: "barracks", level: 1 }. */
	requires?: { building: string; level: number };
}

/** A multiplier on a garrison's strength, e.g. a hero commanding it. Must only read. */
export type PowerModifier = (api: EngineApi, settlementId: string) => Promise<{ source: string; attack?: number; defense?: number } | null>;

export interface TroopsService {
	define(def: UnitDef): void;
	list(): readonly UnitDef[];
	/** Garrison counts by unit id (due training applied; changes in a command are reflected). */
	garrison(api: EngineApi, settlementId: string): Promise<Map<string, number>>;
	/** Change a garrison (settles the pool first, since upkeep changes). Clamps at 0. */
	adjust(api: EngineApi, settlementId: string, unit: string, delta: number): Promise<void>;
	addPowerModifier(modifier: PowerModifier): void;
	/** Attack/defense totals of a garrison after all modifiers (for combat and display). */
	power(
		api: EngineApi,
		settlementId: string,
	): Promise<{ attack: number; defense: number; factors: { source: string; attack: number; defense: number }[] }>;
}

declare module '../../kernel' {
	interface ServiceMap {
		troops: TroopsService;
	}
}

const TRAINED = 'troops.trained';
const DEFICIT = 'troops.deficit';

export default definePlugin({
	id: 'troops',
	version: '0.1.0',
	description: 'Unit types, training, garrisons and upkeep',
	dependsOn: ['settlements', 'buildings', 'resources', 'timeline'],
	setup(ctx) {
		const settlements = ctx.services.get('settlements');
		const buildings = ctx.services.get('buildings');
		const resources = ctx.services.get('resources');
		const timeline = ctx.services.get('timeline');
		const defs = new Map<string, UnitDef>();
		const powerModifiers: PowerModifier[] = [];

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
		const loadTraining = (api: ReadApi, settlementId: string) =>
			api.memo(`troops:training:${settlementId}`, async () => {
				const row = await api.db
					.prepare('SELECT unit, count, started_at, finishes_at FROM troops_training WHERE settlement_id = ?')
					.bind(settlementId)
					.first<{ unit: string; count: number; started_at: number; finishes_at: number }>();
				return { current: row ? { unit: row.unit, count: row.count, startedAt: row.started_at, finishesAt: row.finishes_at } : null };
			});
		const writeCount = (api: EngineApi, settlementId: string, unit: string, count: number) =>
			api.write(
				api.db
					.prepare(
						'INSERT INTO troops_garrison (settlement_id, unit, count) VALUES (?, ?, ?) ON CONFLICT (settlement_id, unit) DO UPDATE SET count = excluded.count',
					)
					.bind(settlementId, unit, count),
			);
		const deficitPenalty = ctx.config.define('deficitPenalty', {
			description:
				'Strength multiplier while a resource is in deficit, e.g. {"iron": 0.7} = troops fight at 70% without metal for their gear. Omitted resources: no penalty.',
			default: (): Record<string, number> => ({}),
			parse(raw) {
				if (typeof raw !== 'object' || raw === null) throw new GameError('bad_config', 'Expected { resource: factor }');
				return Object.fromEntries(Object.entries(raw).map(([r, f]) => [r, numberInRange(0, 1)(f)]));
			},
		});
		const desertionRate = ctx.config.define('desertionRate', {
			description: 'Share of the units that need a resource which desert each time it runs out (0-1).',
			default: () => 0.25,
			parse: numberInRange(0, 1),
		});
		const deficitInterval = ctx.config.define('deficitInterval', {
			description: 'Seconds between further desertions while upkeep still exceeds income.',
			default: () => 600,
			parse: numberInRange(10, 1e7),
		});

		/**
		 * Units that consume `resource` desert, from `at` on, every `deficitInterval` for as long as
		 * the resource stays empty with upkeep above income. Runs inside the timeline.
		 */
		async function desert(api: EngineApi, settlementId: string, resource: string, at: number) {
			const holder = settlements.entity(settlementId);
			await resources.settle(api, holder);
			const g = await loadGarrison(api, settlementId);
			const interval = deficitInterval.get(api) * 1000;
			for (let t = at; ; t += interval) {
				if (t > at) {
					// Later rounds: stop once income covers upkeep again or the stock recovered.
					const stillShort =
						((await resources.rates(api, holder))[resource] ?? 0) < 0 && ((await resources.peekAmounts(api, holder))[resource] ?? 0) <= 0;
					if (!stillShort) return;
				}
				if (t > api.now) {
					timeline.schedule(api, holder, t, DEFICIT, { settlementId, resource });
					return;
				}
				for (const [unit, count] of g) {
					if (!count || !(defs.get(unit)?.upkeep[resource] ?? 0)) continue;
					const left = count - Math.ceil(count * desertionRate.get(api));
					g.set(unit, left);
					writeCount(api, settlementId, unit, left);
				}
			}
		}

		const settlementOf = (holder: string) => (holder.startsWith('settlement:') ? holder.slice('settlement:'.length) : null);

		const service: TroopsService = {
			define(def) {
				if (defs.has(def.id)) throw new PluginError(`Unit "${def.id}" defined twice`);
				defs.set(def.id, def);
			},
			list: () => [...defs.values()],
			async garrison(api, settlementId) {
				await timeline.sync(api, settlements.entity(settlementId));
				return loadGarrison(api, settlementId);
			},
			addPowerModifier: (m) => void powerModifiers.push(m),
			async power(api, settlementId) {
				let attack = 0;
				let defense = 0;
				for (const [unit, count] of await service.garrison(api, settlementId)) {
					attack += (defs.get(unit)?.attack ?? 0) * count;
					defense += (defs.get(unit)?.defense ?? 0) * count;
				}
				const factors: { source: string; attack: number; defense: number }[] = [];
				const holder = settlements.entity(settlementId);
				for (const [resource, f] of Object.entries(deficitPenalty.get(api))) {
					if (await resources.inDeficit(api, holder, resource)) factors.push({ source: `${resource} shortage`, attack: f, defense: f });
				}
				for (const m of powerModifiers) {
					const r = await m(api, settlementId);
					if (r) factors.push({ source: r.source, attack: r.attack ?? 1, defense: r.defense ?? 1 });
				}
				for (const f of factors) {
					attack *= f.attack;
					defense *= f.defense;
				}
				return { attack, defense, factors };
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
			for (const [unit, count] of await loadGarrison(api, id)) {
				for (const [r, perUnit] of Object.entries(defs.get(unit)?.upkeep ?? {})) out[r] = (out[r] ?? 0) + perUnit * count;
			}
			return out;
		});

		resources.onDepleted(async (api, e) => {
			const id = settlementOf(e.holder);
			if (id) await desert(api, id, e.resource, e.at);
		});
		timeline.on<{ settlementId: string; resource: string }>(DEFICIT, async (api, event) => {
			const { settlementId, resource } = event.payload;
			const holder = settlements.entity(settlementId);
			const short =
				((await resources.rates(api, holder))[resource] ?? 0) < 0 && ((await resources.peekAmounts(api, holder))[resource] ?? 0) <= 0;
			if (short) await desert(api, settlementId, resource, event.dueAt);
		});

		timeline.on<{ settlementId: string; unit: string; count: number }>(TRAINED, async (api, event) => {
			const { settlementId, unit, count } = event.payload;
			// The pool was already advanced to this moment by the timeline; upkeep starts now.
			const g = await loadGarrison(api, settlementId);
			g.set(unit, (g.get(unit) ?? 0) + count);
			writeCount(api, settlementId, unit, g.get(unit)!);
			(await loadTraining(api, settlementId)).current = null;
			api.write(api.db.prepare('DELETE FROM troops_training WHERE settlement_id = ?').bind(settlementId));
		});

		/** Why `unit` cannot be trained in `s` right now (ignoring cost), or null. */
		async function blocked(api: EngineApi, s: Settlement, def: UnitDef): Promise<string | null> {
			if (!settlements.kind(s.kind).garrison) return `${settlements.kind(s.kind).name} cannot hold troops`;
			if ((await loadTraining(api, s.id)).current) return 'Already training';
			if (def.requires && (await buildings.level(api, s.id, def.requires.building)) < def.requires.level) {
				return `Requires ${buildings.get(def.requires.building).name} ${def.requires.level}`;
			}
			return null;
		}

		ctx.commands.add<{ settlement: string; unit: string; count: number }>({
			type: 'troops.train',
			description: 'Train a batch of units in a settlement.',
			form: {
				title: 'Train troops',
				placement: 'troops',
				fields: [
					{ name: 'settlement', label: 'settlement', type: 'hidden' },
					{ name: 'unit', label: 'Unit', type: 'select', required: true },
					{ name: 'count', label: 'How many', type: 'number', required: true, min: 1, default: 10 },
				],
				submitLabel: 'Train',
				async prepare(api, params) {
					const s = await settlements.resolve(api, params);
					if (!s) return false;
					await service.garrison(api, s.id);
					const options: { value: string; label: string }[] = [];
					for (const d of service.list()) {
						if (await blocked(api, s, d)) continue;
						const cost = Object.entries(d.cost)
							.map(([r, n]) => `${n} ${r}`)
							.join(', ');
						options.push({ value: d.id, label: `${d.name} — ${cost}, ${Math.max(1, Math.ceil(d.seconds / speed.get(api)))}s each` });
					}
					return options.length
						? { defaults: { settlement: s.id }, options: { unit: options }, description: 'Costs and time are per unit.' }
						: false;
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
				await resources.spend(api, settlements.entity(s.id), Object.fromEntries(Object.entries(def.cost).map(([r, n]) => [r, n * count])));
				const finishesAt = api.now + Math.max(1, Math.ceil((def.seconds * count) / speed.get(api))) * 1000;
				(await loadTraining(api, s.id)).current = { unit, count, startedAt: api.now, finishesAt };
				api.write(
					api.db
						.prepare('INSERT INTO troops_training (settlement_id, unit, count, started_at, finishes_at) VALUES (?, ?, ?, ?, ?)')
						.bind(s.id, unit, count, api.now, finishesAt),
				);
				timeline.schedule(api, settlements.entity(s.id), finishesAt, TRAINED, { settlementId: s.id, unit, count });
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

		ctx.meta.add('units', () =>
			service
				.list()
				.map(({ id, name, icon, attack, defense, upkeep, speed, carry }) => ({ id, name, icon, attack, defense, upkeep, speed, carry })),
		);

		ctx.views.add({
			id: 'troops.garrison',
			async compute(api, params): Promise<GarrisonInfo | null> {
				const s = await settlements.resolve(api, params);
				if (!s) return null;
				const g = await service.garrison(api, s.id);
				const upkeep: Record<string, number> = {};
				for (const [unit, count] of g) {
					for (const [r, perUnit] of Object.entries(defs.get(unit)?.upkeep ?? {})) upkeep[r] = (upkeep[r] ?? 0) + perUnit * count;
				}
				return {
					settlement: s.id,
					allowed: settlements.kind(s.kind).garrison,
					units: [...g].filter(([, n]) => n > 0).map(([id, count]) => ({ id, count })),
					training: (await loadTraining(api, s.id)).current,
					power: await service.power(api, s.id),
					upkeep,
					trainable: await Promise.all(
						service.list().map(async (d) => ({
							unit: d.id,
							cost: d.cost,
							seconds: Math.max(1, Math.ceil(d.seconds / speed.get(api))),
							blocked: (await blocked(api, s, d)) ?? undefined,
						})),
					),
				};
			},
		});
	},
});
