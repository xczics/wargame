/**
 * Buildings: what stands in a settlement's slots, and how it is built and upgraded.
 *
 * Open to other plugins:
 *   - `define()` new building types (e.g. a challenge plugin's "arena", capital only);
 *   - `addGate()` to block starting a level (research: "level 10 needs Masonry II");
 *   - `level()` / `highestOwned()` to require buildings elsewhere ("build an arena first");
 *   - `raiseCap()` for breakthroughs past the regular cap (items); there is no final cap.
 *
 * Costs: each type has a planning table for its first levels (typically 1-7). Past the
 * table, level L costs `last row x costGrowth^(L - rows)`, likewise for time. Tables,
 * growth factors and caps are GM-tunable (`buildings.rules`).
 *
 * Building takes time: starting spends resources and schedules a timeline event; the
 * level applies when it is due (production switches at exactly that moment).
 */
import {
	csvLevels,
	csvMap,
	csvNumber,
	csvRows,
	csvRules,
	definePlugin,
	type EngineApi,
	GameError,
	numberInRange,
	numberRecord,
	planRow,
	PluginError,
	type ReadApi,
	recordOf,
} from '../../kernel';
import type { BuildingEffects, BuildOption, SlotInfo } from '../../shared/api';
import type { Cost } from '../resources';
import type { District, Settlement } from '../settlements';
import rulesCsv from './data/rules.csv?raw';

/** Design numbers (./data/rules.csv); GM overrides go on top. */
const RULES = csvRules(rulesCsv);

export interface LevelRow {
	cost: Cost;
	/** Build time in seconds (before `buildings.speed`). */
	seconds: number;
}

export interface BuildingDef {
	id: string;
	name: string;
	icon?: string;
	/** Which districts accept it is declared per settlement kind (e.g. "resource" only in outer cities). */
	category: string;
	/** Restrict to these settlement kinds (e.g. ["capital"]). Omit: any kind that accepts the category. */
	kinds?: string[];
	/** At most one per settlement (true) or per district ('district', e.g. one per outer city). */
	unique?: boolean | 'district';
	/**
	 * Planning table, index = level - 1. Levels 1-7 (or up to the cap, if lower) must be
	 * given; higher ones may be null or missing: they grow from the nearest lower row.
	 */
	levels: (LevelRow | null)[];
	/** Past the table, each level multiplies the last row's cost by this. Default: data/rules.csv. */
	costGrowth?: number;
	/** Same for time. Default: data/rules.csv. */
	timeGrowth?: number;
	/** Regular cap, reachable once all gating research is done. Default: data/rules.csv. */
	cap?: number;
	/** Production per second per level, by resource. */
	produces?: Record<string, number>;
	/** Flat stat bonus per level for the settlement, e.g. { "resources.capacity": 2000 }. */
	stats?: Record<string, number>;
}

export type DistrictBonus = (api: ReadApi, settlement: Settlement, district: District) => Promise<Record<string, number>>;

export interface Placed {
	building: string;
	level: number;
	/** Breakthrough cap of this instance; null = the type's regular cap. */
	cap: number | null;
}

export interface UpgradeRequest {
	settlement: Settlement;
	districtId: string;
	slot: number;
	building: BuildingDef;
	/** 0 when building new. */
	fromLevel: number;
	toLevel: number;
}

/** Return a reason to block the upgrade, or null to allow it. Must only read. */
export type BuildGate = (api: EngineApi, request: UpgradeRequest) => Promise<string | null>;

interface Construction {
	districtId: string;
	slot: number;
	building: string;
	targetLevel: number;
	startedAt: number;
	finishesAt: number;
}

export interface BuildingsService {
	define(def: BuildingDef): void;
	/**
	 * Define buildings from CSV (see kernel/data.ts). `buildings`: id, name, icon, category,
	 * unique (empty | settlement | district), cap, kinds ("a; b"), produces / stats ("key:n; key:n"),
	 * costGrowth, timeGrowth (optional columns). `levels`: id, level, seconds, one column per resource.
	 */
	defineFromCsv(buildings: string, levels: string): void;
	get(id: string): BuildingDef;
	list(): readonly BuildingDef[];
	addGate(gate: BuildGate): void;
	/** Cost and time of reaching `level`, under the current rules. */
	levelCost(api: ReadApi, id: string, level: number): LevelRow;
	/** Buildings by district id, then slot (due constructions applied). */
	placed(api: EngineApi, settlementId: string): Promise<Map<string, Map<number, Placed>>>;
	/** Highest level of a building type in a settlement (0 if none). */
	level(api: EngineApi, settlementId: string, buildingId: string): Promise<number>;
	/** Highest level of a building type across a player's settlements, optionally of one kind. */
	highestOwned(api: EngineApi, playerId: string, buildingId: string, options?: { kind?: string }): Promise<number>;
	/** Why this upgrade cannot start (placement, uniqueness, caps, gates), or null. Ignores cost and queue. */
	check(api: EngineApi, request: UpgradeRequest): Promise<string | null>;
	/** Effective level cap of a placed building (its breakthrough cap or the type's regular cap). */
	capOf(api: ReadApi, placed: Placed): number;
	/** Raise one instance's cap by `by` levels (breakthrough). */
	raiseCap(api: EngineApi, settlementId: string, districtId: string, slot: number, by: number): Promise<void>;
	/** Cost and time of an upgrade in its settlement: `levelCost` with the time modifiers applied. */
	quote(api: EngineApi, request: UpgradeRequest): Promise<LevelRow>;
	/** Multiplier on construction time (e.g. 0.9 = 10% faster), e.g. from a governor. Must only read. */
	addTimeModifier(modifier: (api: EngineApi, request: UpgradeRequest) => Promise<number>): void;
	/**
	 * Extra percent production of the buildings in one district, by resource (e.g. the terrain
	 * under it). Added to the settlement's general production bonus. Must only read.
	 */
	addDistrictBonus(bonus: DistrictBonus): void;
	/** Put a building into an empty slot at `level` at once — no cost, time or placement rules (e.g. starting buildings). */
	place(api: EngineApi, settlementId: string, districtId: string, slot: number, buildingId: string, level: number): Promise<void>;
}

declare module '../../kernel' {
	interface ServiceMap {
		buildings: BuildingsService;
	}
}

const COMPLETE = 'buildings.complete';
const key = (districtId: string, slot: number) => `${districtId}:${slot}`;
/** Planning-table levels that must be given; higher ones may grow from the nearest lower row. */
const REQUIRED_ROWS = 7;

export default definePlugin({
	id: 'buildings',
	version: '0.1.0',
	description: 'Building types, levels, construction queue, research gates and caps',
	dependsOn: ['settlements', 'resources', 'stats', 'timeline'],
	setup(ctx) {
		const settlements = ctx.services.get('settlements');
		const districtBonuses: DistrictBonus[] = [];
		const timeModifiers: ((api: EngineApi, request: UpgradeRequest) => Promise<number>)[] = [];
		const resources = ctx.services.get('resources');
		const stats = ctx.services.get('stats');
		const timeline = ctx.services.get('timeline');
		const defs = new Map<string, BuildingDef>();
		const gates: BuildGate[] = [];
		const statsContributed = new Set<string>();

		/* ----- GM-tunable rules ---------------------------------------------------------- */

		type Rule = Required<Pick<BuildingDef, 'levels' | 'costGrowth' | 'timeGrowth' | 'cap'>>;
		const contentRules = (): Record<string, Rule> =>
			Object.fromEntries(
				[...defs.values()].map((d) => [
					d.id,
					{
						levels: d.levels,
						costGrowth: d.costGrowth ?? RULES.costGrowth,
						timeGrowth: d.timeGrowth ?? RULES.timeGrowth,
						cap: d.cap ?? RULES.cap,
					},
				]),
			);
		const resourceIds = () => resources.list().map((r) => r.id);
		const parseLevels = (raw: unknown): (LevelRow | null)[] => {
			if (!Array.isArray(raw) || raw.length === 0) throw new GameError('bad_config', 'levels must be a non-empty array');
			const required = Math.min(REQUIRED_ROWS, raw.length);
			return raw.map((row, i) => {
				// Higher levels may be left out (null): they grow from the nearest lower row.
				if (row === null && i >= required) return null;
				const r = (row ?? {}) as Record<string, unknown>;
				try {
					return { cost: numberRecord(resourceIds, 0, 1e15)(r.cost ?? {}), seconds: numberInRange(1, 1e9)(r.seconds) };
				} catch (err) {
					throw new GameError('bad_config', `levels[${i}]: ${(err as Error).message}`);
				}
			});
		};
		const parseOverrides = recordOf(
			() => defs.keys(),
			(raw, id): Partial<Rule> => {
				const r = (raw ?? {}) as Record<string, unknown>;
				const out: Partial<Rule> = {};
				try {
					if ('levels' in r) out.levels = parseLevels(r.levels);
					if ('costGrowth' in r) out.costGrowth = numberInRange(1, 10)(r.costGrowth);
					if ('timeGrowth' in r) out.timeGrowth = numberInRange(1, 10)(r.timeGrowth);
					if ('cap' in r) out.cap = numberInRange(1, 1e6)(r.cap);
				} catch (err) {
					throw new GameError('bad_config', `"${id}": ${(err as Error).message}`);
				}
				return out;
			},
		);
		const rules = ctx.config.define<Record<string, Rule>>('rules', {
			description:
				'Per building: { "levels": [{ "cost": {res: n}, "seconds": s }, ...], "costGrowth": 1.3, "timeGrowth": 1.25, "cap": 20 }. Levels past the table grow from its last row. Omitted fields keep the content default.',
			default: contentRules,
			parse(raw) {
				const merged = contentRules();
				for (const [id, o] of Object.entries(parseOverrides(raw))) merged[id] = { ...merged[id], ...o };
				return merged;
			},
		});
		const speed = ctx.config.define('speed', {
			description: 'Build speed multiplier (2 = everything builds twice as fast).',
			default: () => 1,
			parse: numberInRange(0.01, 1e6),
		});
		const productionMultiplier = ctx.config.define('productionMultiplier', {
			description: 'Global multiplier on all building output (events, balancing).',
			default: () => 1,
			parse: numberInRange(0, 1e6),
		});
		const cancelRefund = ctx.config.define('cancelRefund', {
			description: 'Share of the cost returned when a construction is cancelled (0-1).',
			default: () => RULES.cancelRefund as number,
			parse: numberInRange(0, 1),
		});
		const ownResourceFreeUntil = ctx.config.define('ownResourceFreeUntil', {
			description: 'Up to this level a building costs none of the resources it produces (e.g. a lumber mill needs no wood). 0 = off.',
			default: () => RULES.ownResourceFreeUntil as number,
			parse: numberInRange(0, 1000),
		});
		const queueSize = ctx.config.define('queueSize', {
			description: 'Simultaneous constructions per settlement before bonuses.',
			default: () => RULES.queueSize as number,
			parse: numberInRange(1, 100),
		});
		stats.define({
			id: 'buildings.queue',
			description: 'Simultaneous constructions per settlement',
			base: (api) => queueSize.get(api),
			integer: true,
			min: 1,
		});

		/* ----- state ------------------------------------------------------------------- */

		const loadPlaced = (api: ReadApi, settlementId: string) =>
			api.memo(`buildings:placed:${settlementId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT district_id, slot, building, level, cap FROM buildings_slots WHERE settlement_id = ?')
					.bind(settlementId)
					.all<{ district_id: string; slot: number; building: string; level: number; cap: number | null }>();
				const out = new Map<string, Map<number, Placed>>();
				for (const r of results) {
					if (!out.has(r.district_id)) out.set(r.district_id, new Map());
					out.get(r.district_id)!.set(r.slot, { building: r.building, level: r.level, cap: r.cap });
				}
				return out;
			});

		const loadConstruction = (api: ReadApi, settlementId: string) =>
			api.memo(`buildings:construction:${settlementId}`, async () => {
				const { results } = await api.db
					.prepare(
						'SELECT district_id, slot, building, target_level, started_at, finishes_at FROM buildings_construction WHERE settlement_id = ?',
					)
					.bind(settlementId)
					.all<{ district_id: string; slot: number; building: string; target_level: number; started_at: number; finishes_at: number }>();
				return new Map<string, Construction>(
					results.map((r) => [
						key(r.district_id, r.slot),
						{
							districtId: r.district_id,
							slot: r.slot,
							building: r.building,
							targetLevel: r.target_level,
							startedAt: r.started_at,
							finishesAt: r.finishes_at,
						},
					]),
				);
			});

		const writeSlot = (api: EngineApi, settlementId: string, districtId: string, slot: number, p: Placed) =>
			api.write(
				api.db
					.prepare(
						`INSERT INTO buildings_slots (district_id, slot, settlement_id, building, level, cap) VALUES (?, ?, ?, ?, ?, ?)
						 ON CONFLICT (district_id, slot) DO UPDATE SET building = excluded.building, level = excluded.level, cap = excluded.cap`,
					)
					.bind(districtId, slot, settlementId, p.building, p.level, p.cap),
			);

		/** Effect of one building at `level` under the current rules (production multiplier included). */
		const effectsAt = (api: ReadApi, def: BuildingDef, level: number): BuildingEffects => {
			const mult = productionMultiplier.get(api);
			return {
				produces: Object.fromEntries(Object.entries(def.produces ?? {}).map(([r, n]) => [r, n * level * mult])),
				stats: Object.fromEntries(Object.entries(def.stats ?? {}).map(([s, n]) => [s, n * level])),
			};
		};

		const settlementOf = (holder: string) => (holder.startsWith('settlement:') ? holder.slice('settlement:'.length) : null);

		/* ----- service ------------------------------------------------------------------ */

		const service: BuildingsService = {
			defineFromCsv(buildingsCsv, levelsCsv) {
				const levels = csvLevels(levelsCsv);
				for (const row of csvRows(buildingsCsv)) {
					const rows = levels.get(row.id);
					if (!rows) throw new PluginError(`Building "${row.id}" has no rows in its levels table`);
					if (row.unique && row.unique !== 'settlement' && row.unique !== 'district')
						throw new PluginError(`Building "${row.id}": unique must be empty, "settlement" or "district"`);
					service.define({
						id: row.id,
						name: row.name,
						icon: row.icon || undefined,
						category: row.category,
						unique: row.unique === 'district' ? 'district' : row.unique === 'settlement',
						cap: row.cap ? csvNumber(row, 'cap') : undefined,
						kinds: row.kinds
							? row.kinds
									.split(';')
									.map((k) => k.trim())
									.filter(Boolean)
							: undefined,
						produces: row.produces ? csvMap(row.produces) : undefined,
						stats: row.stats ? csvMap(row.stats) : undefined,
						costGrowth: row.costGrowth ? csvNumber(row, 'costGrowth') : undefined,
						timeGrowth: row.timeGrowth ? csvNumber(row, 'timeGrowth') : undefined,
						levels: rows,
					});
				}
			},
			define(def) {
				if (defs.has(def.id)) throw new PluginError(`Building "${def.id}" defined twice`);
				const required = Math.min(REQUIRED_ROWS, def.cap ?? RULES.cap, def.levels.length || 1);
				for (let i = 0; i < required; i++)
					if (!def.levels[i]) throw new PluginError(`Building "${def.id}" needs planning-table rows for levels 1-${required}`);
				defs.set(def.id, def);
				for (const statId of Object.keys(def.stats ?? {})) {
					if (statsContributed.has(statId)) continue;
					statsContributed.add(statId);
					stats.contribute(statId, async (api, target) => {
						const id = settlementOf(target);
						if (!id) return null;
						let flat = 0;
						for (const district of (await loadPlaced(api, id)).values()) {
							for (const p of district.values()) flat += (defs.get(p.building)?.stats?.[statId] ?? 0) * p.level;
						}
						return { flat };
					});
				}
			},
			get(id) {
				const def = defs.get(id);
				if (!def) throw new GameError('unknown_building', `Unknown building "${id}"`);
				return def;
			},
			list: () => [...defs.values()],
			addGate: (g) => void gates.push(g),

			levelCost(api, id, level) {
				const r = rules.get(api)[id];
				if (!r) throw new GameError('unknown_building', `Unknown building "${id}"`);
				const { row, beyond } = planRow(r.levels, level);
				const seconds = Math.max(1, Math.ceil((row.seconds * r.timeGrowth ** beyond) / speed.get(api)));
				const own = level <= ownResourceFreeUntil.get(api) ? (defs.get(id)?.produces ?? {}) : {};
				return {
					cost: Object.fromEntries(
						Object.entries(row.cost)
							.filter(([res]) => !own[res])
							.map(([res, c]) => [res, Math.ceil(c * r.costGrowth ** beyond)]),
					),
					seconds,
				};
			},

			async placed(api, settlementId) {
				await timeline.sync(api, settlements.entity(settlementId));
				return loadPlaced(api, settlementId);
			},
			async level(api, settlementId, buildingId) {
				let best = 0;
				for (const district of (await service.placed(api, settlementId)).values()) {
					for (const p of district.values()) if (p.building === buildingId) best = Math.max(best, p.level);
				}
				return best;
			},
			async highestOwned(api, playerId, buildingId, { kind } = {}) {
				let best = 0;
				for (const s of await settlements.mine(api, playerId)) {
					if (!kind || s.kind === kind) best = Math.max(best, await service.level(api, s.id, buildingId));
				}
				return best;
			},

			async check(api, req) {
				const { settlement, building: def, toLevel } = req;
				const { template } = settlements.district(settlement, req.districtId);
				if (!template.accepts.includes(def.category)) return `${def.name} cannot be built in this district`;
				if (def.kinds && !def.kinds.includes(settlement.kind)) return `${def.name} can only be built in: ${def.kinds.join(', ')}`;
				if (def.unique && req.fromLevel === 0) {
					const perDistrict = def.unique === 'district';
					const placed = await service.placed(api, settlement.id);
					const inProgress = await loadConstruction(api, settlement.id);
					const exists =
						[...placed.entries()].some(
							([d, slots]) => (!perDistrict || d === req.districtId) && [...slots.values()].some((p) => p.building === def.id),
						) || [...inProgress.values()].some((c) => c.building === def.id && (!perDistrict || c.districtId === req.districtId));
					if (exists) return perDistrict ? `Only one ${def.name} per district` : `Only one ${def.name} per settlement`;
				}
				const instance = (await service.placed(api, settlement.id)).get(req.districtId)?.get(req.slot);
				const cap = instance?.cap ?? rules.get(api)[def.id].cap;
				if (toLevel > cap) return `Level cap ${cap} reached`;
				for (const gate of gates) {
					const reason = await gate(api, req);
					if (reason) return reason;
				}
				return null;
			},

			addDistrictBonus: (b) => void districtBonuses.push(b),
			addTimeModifier: (m) => void timeModifiers.push(m),
			async quote(api, req) {
				const { cost, seconds } = service.levelCost(api, req.building.id, req.toLevel);
				let factor = 1;
				for (const m of timeModifiers) factor *= await m(api, req);
				return { cost, seconds: Math.max(1, Math.ceil(seconds * Math.max(0, factor))) };
			},
			capOf: (api, p) => p.cap ?? rules.get(api)[p.building].cap,
			async place(api, settlementId, districtId, slot, buildingId, level) {
				service.get(buildingId);
				const placed = await service.placed(api, settlementId);
				if (placed.get(districtId)?.get(slot)) throw new GameError('slot_taken', 'That slot already has a building');
				await resources.settle(api, settlements.entity(settlementId));
				if (!placed.has(districtId)) placed.set(districtId, new Map());
				const p: Placed = { building: buildingId, level, cap: null };
				placed.get(districtId)!.set(slot, p);
				writeSlot(api, settlementId, districtId, slot, p);
			},
			async raiseCap(api, settlementId, districtId, slot, by) {
				const p = (await service.placed(api, settlementId)).get(districtId)?.get(slot);
				if (!p) throw new GameError('not_found', 'No building in that slot', 404);
				p.cap = (p.cap ?? rules.get(api)[p.building].cap) + by;
				writeSlot(api, settlementId, districtId, slot, p);
			},
		};
		ctx.services.provide('buildings', service);

		/* ----- production & completion -------------------------------------------------- */

		resources.addProducer(async (api, holder) => {
			const id = settlementOf(holder);
			if (!id) return {};
			const mult = productionMultiplier.get(api);
			const settlement = districtBonuses.length ? await settlements.get(api, id) : null;
			const out: Record<string, { amount: number; percent: number }[]> = {};
			for (const [districtId, slots] of await loadPlaced(api, id)) {
				const produced: Record<string, number> = {};
				for (const p of slots.values()) {
					for (const [r, perLevel] of Object.entries(defs.get(p.building)?.produces ?? {}))
						produced[r] = (produced[r] ?? 0) + perLevel * p.level * mult;
				}
				if (!Object.keys(produced).length) continue;
				// Each district's production carries its own bonus (e.g. terrain), by resource.
				const bonus: Record<string, number> = {};
				const district = settlement?.districts.find((d) => d.id === districtId);
				if (settlement && district)
					for (const b of districtBonuses)
						for (const [r, pct] of Object.entries(await b(api, settlement, district))) bonus[r] = (bonus[r] ?? 0) + pct;
				for (const [r, amount] of Object.entries(produced)) (out[r] ??= []).push({ amount, percent: bonus[r] ?? 0 });
			}
			return out;
		});

		timeline.on<{ settlementId: string; districtId: string; slot: number; building: string; level: number }>(
			COMPLETE,
			async (api, event) => {
				const { settlementId, districtId, slot, building, level } = event.payload;
				const placed = await loadPlaced(api, settlementId);
				if (!placed.has(districtId)) placed.set(districtId, new Map());
				const existing = placed.get(districtId)!.get(slot);
				const p: Placed = { building, level, cap: existing?.cap ?? null };
				placed.get(districtId)!.set(slot, p);
				writeSlot(api, settlementId, districtId, slot, p);
				(await loadConstruction(api, settlementId)).delete(key(districtId, slot));
				api.write(api.db.prepare('DELETE FROM buildings_construction WHERE district_id = ? AND slot = ?').bind(districtId, slot));
			},
		);

		/* ----- construct ---------------------------------------------------------------- */

		/** The request for building/upgrading a slot, or a reason why the slot cannot take it. */
		async function prepare(api: EngineApi, settlement: Settlement, districtId: string, slot: number, buildingId?: string) {
			const { district } = settlements.district(settlement, districtId);
			if (!Number.isInteger(slot) || slot < 0 || slot >= district.slots) throw new GameError('bad_slot', 'No such slot');
			const current = (await service.placed(api, settlement.id)).get(districtId)?.get(slot);
			if (current && buildingId && buildingId !== current.building)
				throw new GameError('slot_taken', 'That slot already has another building');
			const def = service.get(current?.building ?? buildingId ?? '');
			return {
				settlement,
				districtId,
				slot,
				building: def,
				fromLevel: current?.level ?? 0,
				toLevel: (current?.level ?? 0) + 1,
			} satisfies UpgradeRequest;
		}

		async function queueState(api: EngineApi, settlementId: string) {
			const used = (await loadConstruction(api, settlementId)).size;
			const size = await stats.get(api, 'buildings.queue', settlements.entity(settlementId));
			return { used, size };
		}

		ctx.commands.add<{ settlement: string; district: string; slot: number; building?: string }>({
			type: 'buildings.construct',
			description: 'Build in an empty slot or upgrade the building in it.',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.settlement !== 'string' || typeof p.district !== 'string')
					throw new GameError('bad_payload', 'settlement and district are required');
				const slot = Number(p.slot);
				if (!Number.isInteger(slot)) throw new GameError('bad_payload', 'slot must be an integer');
				if (p.building !== undefined && typeof p.building !== 'string') throw new GameError('bad_payload', 'building must be a string');
				return { settlement: p.settlement, district: p.district, slot, building: p.building as string | undefined };
			},
			async execute(api, { settlement: settlementId, district, slot, building }) {
				const settlement = await settlements.requireOwned(api, settlementId);
				const req = await prepare(api, settlement, district, slot, building);
				if ((await loadConstruction(api, settlement.id)).has(key(district, slot)))
					throw new GameError('busy', 'Already under construction');
				const { used, size } = await queueState(api, settlement.id);
				if (used >= size) throw new GameError('queue_full', `Construction queue full (${used}/${size})`);
				const reason = await service.check(api, req);
				if (reason) throw new GameError('blocked', reason);

				const { cost, seconds } = await service.quote(api, req);
				await resources.spend(api, settlements.entity(settlement.id), cost);
				const finishesAt = api.now + seconds * 1000;
				(await loadConstruction(api, settlement.id)).set(key(district, slot), {
					districtId: district,
					slot,
					building: req.building.id,
					targetLevel: req.toLevel,
					startedAt: api.now,
					finishesAt,
				});
				api.write(
					api.db
						.prepare(
							'INSERT INTO buildings_construction (district_id, slot, settlement_id, building, target_level, started_at, finishes_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
						)
						.bind(district, slot, settlement.id, req.building.id, req.toLevel, api.now, finishesAt),
				);
				timeline.schedule(api, settlements.entity(settlement.id), finishesAt, COMPLETE, {
					settlementId: settlement.id,
					districtId: district,
					slot,
					building: req.building.id,
					level: req.toLevel,
				});
			},
		});

		ctx.commands.add<{ settlement: string; district: string; slot: number }>({
			type: 'buildings.cancel',
			description: 'Cancel a construction in progress; part of the cost is refunded (`buildings.cancelRefund`).',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.settlement !== 'string' || typeof p.district !== 'string')
					throw new GameError('bad_payload', 'settlement and district are required');
				const slot = Number(p.slot);
				if (!Number.isInteger(slot)) throw new GameError('bad_payload', 'slot must be an integer');
				return { settlement: p.settlement, district: p.district, slot };
			},
			async execute(api, { settlement: settlementId, district, slot }) {
				const settlement = await settlements.requireOwned(api, settlementId);
				await service.placed(api, settlement.id); // process anything already due first
				const construction = await loadConstruction(api, settlement.id);
				const c = construction.get(key(district, slot));
				if (!c) throw new GameError('not_found', 'Nothing is being built there', 404);
				const holder = settlements.entity(settlement.id);
				const refund = cancelRefund.get(api);
				for (const [r, n] of Object.entries(service.levelCost(api, c.building, c.targetLevel).cost)) {
					if (n * refund > 0) await resources.add(api, holder, r, Math.floor(n * refund));
				}
				construction.delete(key(district, slot));
				api.write(api.db.prepare('DELETE FROM buildings_construction WHERE district_id = ? AND slot = ?').bind(district, slot));
				timeline.cancelWhere(api, holder, COMPLETE, { districtId: district, slot });
			},
		});

		ctx.commands.add<{ settlement: string; district: string; slot: number; by: number }>({
			type: 'buildings.raiseCap',
			form: {
				title: 'Raise a building level cap',
				placement: 'gm',
				fields: [
					{ name: 'target', label: 'Building', type: 'select', required: true },
					{ name: 'by', label: 'Levels', type: 'number', required: true, min: 1, default: 1 },
				],
				submitLabel: 'Raise cap',
				async prepare(api) {
					const options: { value: string; label: string }[] = [];
					for (const s of await settlements.mine(api, api.playerId)) {
						for (const d of s.districts) {
							for (const [slot, p] of (await service.placed(api, s.id)).get(d.id) ?? []) {
								options.push({
									value: `${s.id}|${d.id}|${slot}`,
									label: `${s.name} · ${service.get(p.building).name} Lv ${p.level}/${service.capOf(api, p)}`,
								});
							}
						}
					}
					return options.length ? { options: { target: options } } : false;
				},
			},
			privileged: true,
			description:
				'Breakthrough: raise one building’s level cap (what a breakthrough item will do). Payload: { "settlement", "district", "slot", "by": 1 }',
			parse(raw) {
				const p = { ...((raw ?? {}) as Record<string, unknown>) };
				// The GM form sends one "settlement|district|slot" value.
				if (typeof p.target === 'string') [p.settlement, p.district, p.slot] = p.target.split('|');

				if (typeof p.settlement !== 'string' || typeof p.district !== 'string')
					throw new GameError('bad_payload', 'settlement and district are required');
				return { settlement: p.settlement, district: p.district, slot: Number(p.slot), by: numberInRange(1, 1000)(p.by ?? 1) };
			},
			async execute(api, { settlement, district, slot, by }) {
				if (!(await settlements.get(api, settlement))) throw new GameError('not_found', 'No such settlement', 404);
				await service.raiseCap(api, settlement, district, slot, Math.floor(by));
			},
		});

		ctx.commands.add<{ settlement: string; district: string; slot: number; level: number }>({
			type: 'buildings.setLevel',
			form: {
				title: 'Set a building level',
				placement: 'gm',
				fields: [
					{ name: 'target', label: 'Building', type: 'select', required: true },
					{ name: 'level', label: 'Level', type: 'number', required: true, min: 1, default: 1 },
				],
				submitLabel: 'Set level',
				async prepare(api) {
					const options: { value: string; label: string }[] = [];
					for (const s of await settlements.mine(api, api.playerId)) {
						for (const d of s.districts) {
							for (const [slot, p] of (await service.placed(api, s.id)).get(d.id) ?? []) {
								options.push({ value: `${s.id}|${d.id}|${slot}`, label: `${s.name} · ${service.get(p.building).name} Lv ${p.level}` });
							}
						}
					}
					return options.length ? { options: { target: options } } : false;
				},
			},
			privileged: true,
			description:
				'Set an existing building to a level at once, ignoring caps, cost and time. Payload: { "settlement", "district", "slot", "level": 10 }',
			parse(raw) {
				const p = { ...((raw ?? {}) as Record<string, unknown>) };
				if (typeof p.target === 'string') [p.settlement, p.district, p.slot] = p.target.split('|');
				if (typeof p.settlement !== 'string' || typeof p.district !== 'string')
					throw new GameError('bad_payload', 'settlement and district are required');
				return {
					settlement: p.settlement,
					district: p.district,
					slot: Number(p.slot),
					level: Math.floor(numberInRange(1, 10_000)(p.level)),
				};
			},
			async execute(api, { settlement, district, slot, level }) {
				if (!(await settlements.get(api, settlement))) throw new GameError('not_found', 'No such settlement', 404);
				const p = (await service.placed(api, settlement)).get(district)?.get(slot);
				if (!p) throw new GameError('not_found', 'No building in that slot', 404);
				// Production and stats change with the level: bank what the old level produced first.
				await resources.settle(api, settlements.entity(settlement));
				p.level = level;
				writeSlot(api, settlement, district, slot, p);
			},
		});

		/* ----- presentation ------------------------------------------------------------- */

		ctx.meta.add('buildings', () =>
			service
				.list()
				.map((d) => ({ id: d.id, name: d.name, icon: d.icon, category: d.category, cap: d.cap ?? (RULES.cap as number), kinds: d.kinds })),
		);

		settlements.addDetailExtender(async (api, settlement, detail) => {
			const placed = await service.placed(api, settlement.id);
			const construction = await loadConstruction(api, settlement.id);
			const { used, size } = await queueState(api, settlement.id);
			detail.limits.queue = size;
			detail.limits.queueUsed = used;
			const holder = settlements.entity(settlement.id);

			const option = async (req: UpgradeRequest, busy: string | null): Promise<BuildOption> => {
				const { cost, seconds } = await service.quote(api, req);
				const blocked = busy ?? (await service.check(api, req)) ?? undefined;
				return {
					building: req.building.id,
					level: req.toLevel,
					cost,
					seconds,
					effects: effectsAt(api, req.building, req.toLevel),
					affordable: await resources.canAfford(api, holder, cost),
					blocked,
				};
			};

			for (const d of detail.districts) {
				const { district, template } = settlements.district(settlement, d.id);
				const slots: SlotInfo[] = [];
				for (let slot = 0; slot < district.slots; slot++) {
					const current = placed.get(d.id)?.get(slot) ?? null;
					const c = construction.get(key(d.id, slot)) ?? null;
					const busy = c ? 'Under construction' : used >= size ? `Construction queue full (${used}/${size})` : null;
					let options: BuildOption[] = [];
					if (current) {
						options = [
							await option(
								{
									settlement,
									districtId: d.id,
									slot,
									building: service.get(current.building),
									fromLevel: current.level,
									toLevel: current.level + 1,
								},
								busy,
							),
						];
					} else if (!c) {
						const candidates = service
							.list()
							.filter((b) => template.accepts.includes(b.category) && (!b.kinds || b.kinds.includes(settlement.kind)));
						options = await Promise.all(
							candidates.map((b) => option({ settlement, districtId: d.id, slot, building: b, fromLevel: 0, toLevel: 1 }, busy)),
						);
					}
					slots.push({
						slot,
						current: current
							? {
									building: current.building,
									level: current.level,
									effects: effectsAt(api, service.get(current.building), current.level),
									cap: current.cap ?? rules.get(api)[current.building].cap,
								}
							: null,
						construction: c ? { building: c.building, targetLevel: c.targetLevel, startedAt: c.startedAt, finishesAt: c.finishesAt } : null,
						options,
					});
				}
				d.slots = slots;
			}
		});

		ctx.reports.add({
			id: 'buildings.levels',
			description: 'Highest instances of a building type across all settlements.',
			example: { building: 'farm', min: 1, limit: 50 },
			async run(api, params) {
				const p = (params ?? {}) as Record<string, unknown>;
				if (typeof p.building !== 'string' || !defs.has(p.building)) {
					throw new GameError('bad_params', `building must be one of: ${[...defs.keys()].join(', ')}`);
				}
				const min = p.min === undefined ? 1 : numberInRange(0, 1e9)(p.min);
				const limit = p.limit === undefined ? 50 : numberInRange(1, 500)(p.limit);
				const { results } = await api.db
					.prepare(
						'SELECT settlement_id AS settlement, district_id AS district, slot, level, cap FROM buildings_slots WHERE building = ? AND level >= ? ORDER BY level DESC LIMIT ?',
					)
					.bind(p.building, min, Math.floor(limit))
					.all();
				return results;
			},
		});
	},
});
