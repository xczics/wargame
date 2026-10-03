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
	type GrowthStage,
	csvRows,
	csvRules,
	definePlugin,
	type EngineApi,
	errorText,
	fields,
	gameErrors,
	numberInRange,
	numberRecord,
	planRow,
	PluginError,
	type ReadApi,
	recordOf,
	shape,
	stagedGrowth,
} from '../../kernel';
import type { BuildingEffects, BuildOption, SettlementDetail, SlotInfo } from '../../shared/api';
import { amount, costParts, duration } from '../../shared/format';
import type { CardsData, UiCard, UiLine, UiText } from '../../shared/ui';
import type { Cost, ProductionSource } from '../resources';
import type { District, Settlement } from '../settlements';
import type { FactorPart } from '../stats';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, literal, uiTexts } from '../../shared/i18n';

const fail = gameErrors('buildings');
const text = uiTexts('buildings');

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
	/** From level `from` on, `stats` multiply by `factor` per level instead of adding (e.g. the armory doubling from 15). */
	/** Stats grow faster from these levels on (see `stagedGrowth`); linear without. */
	statsGrowth?: GrowthStage[];
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
export type BuildGate = (api: EngineApi, request: UpgradeRequest) => Promise<UiText | null>;

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
	 * costGrowth, timeGrowth, statsGrowthFrom / statsGrowthFactor (optional columns). `levels`: id, level, seconds, one column per resource.
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
	check(api: EngineApi, request: UpgradeRequest): Promise<UiText | null>;
	/** Effective level cap of a placed building (its breakthrough cap or the type's regular cap). */
	capOf(api: ReadApi, settlementId: string, placed: Placed): Promise<number>;
	/** Raise one instance's cap by `by` levels (breakthrough). */
	raiseCap(api: EngineApi, settlementId: string, districtId: string, slot: number, by: number): Promise<void>;
	/** Move a building to an empty slot of the same district (level and cap go with it). Not while either is being built. */
	move(api: EngineApi, settlementId: string, districtId: string, from: number, to: number): Promise<void>;
	/** Swap two buildings of the same district. Not while either is being built. */
	swap(api: EngineApi, settlementId: string, districtId: string, a: number, b: number): Promise<void>;
	/** Cost and time of an upgrade in its settlement: `levelCost` with the time modifiers applied. */
	quote(api: EngineApi, request: UpgradeRequest): Promise<LevelRow>;
	/** Multiplier on construction time (e.g. 0.9 = 10% faster), e.g. from a governor. Must only read. */
	addTimeModifier(modifier: (api: EngineApi, request: UpgradeRequest) => Promise<number>, source?: UiText): void;
	/** Where the construction time of a request comes from: the stat `buildings.speed`, then each named modifier. */
	timeFactors(api: EngineApi, request: UpgradeRequest): Promise<FactorPart[]>;
	/**
	 * Extra percent production of the buildings in one district, by resource (e.g. the terrain
	 * under it). Added to the settlement's general production bonus. Must only read.
	 */
	/** `source`: what players see it as in the production table (e.g. "Terrain"). */
	addDistrictBonus(bonus: DistrictBonus, source?: UiText): void;
	/**
	 * Take `seconds` off the construction finishing soonest in a settlement (e.g. an item); at 0 it
	 * completes now. False if nothing is being built.
	 */
	speedUp(api: EngineApi, settlementId: string, seconds: number): Promise<boolean>;
	/**
	 * Describe what a building does at a level that is not production or a stat of its row (e.g. a wall's
	 * defence, a hidden store's protection): shown with its effects now and at the next level. Must only read.
	 */
	addEffectLines(buildingId: string, describe: (api: ReadApi, settlement: Settlement, level: number) => Promise<UiText[]>): void;
	/** Put a building into an empty slot at `level` at once — no cost, time or placement rules (e.g. starting buildings). */
	place(api: EngineApi, settlementId: string, districtId: string, slot: number, buildingId: string, level: number): Promise<void>;
}

declare module '../../kernel' {
	interface ServiceMap {
		buildings: BuildingsService;
	}
}

/** `statsGrowthFrom` / `statsGrowthFactor` columns: "6; 16" and "1.25; 2" (one factor per stage). */
function growthStages(row: Record<string, string>): GrowthStage[] | undefined {
	if (!row.statsGrowthFrom) return undefined;
	const from = row.statsGrowthFrom.split(';').map((x) => Number(x.trim()));
	const factor = (row.statsGrowthFactor ?? '').split(';').map((x) => Number(x.trim()));
	if (from.length !== factor.length || [...from, ...factor].some((n) => !Number.isFinite(n) || n <= 0))
		throw new PluginError(`Building "${row.id}": statsGrowthFrom / statsGrowthFactor need one positive factor per level`);
	return from.map((f, i) => ({ from: f, factor: factor[i] }));
}
const COMPLETE = 'buildings.complete';
/** Stat of the levels a building type may rise above its regular cap in a settlement. */
const capStat = (id: string) => `buildings.cap.${id}`;
const key = (districtId: string, slot: number) => `${districtId}:${slot}`;
/** Planning-table levels that must be given; higher ones may grow from the nearest lower row. */
const REQUIRED_ROWS = 7;

export default definePlugin({
	id: 'buildings',
	version: '0.1.0',
	description: 'Building types, levels, construction queue, research gates and caps',
	dependsOn: ['settlements', 'resources', 'stats', 'timeline', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const settlements = ctx.services.get('settlements');
		const districtBonuses: { fn: DistrictBonus; source?: UiText }[] = [];
		const timeModifiers: { fn: (api: EngineApi, request: UpgradeRequest) => Promise<number>; source?: UiText }[] = [];
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
			if (!Array.isArray(raw) || raw.length === 0) throw fail('bad_config', 'levels must be a non-empty array');
			const required = Math.min(REQUIRED_ROWS, raw.length);
			return raw.map((row, i) => {
				// Higher levels may be left out (null): they grow from the nearest lower row.
				if (row === null && i >= required) return null;
				const r = (row ?? {}) as Record<string, unknown>;
				try {
					return { cost: numberRecord(resourceIds, 0, 1e15)(r.cost ?? {}), seconds: numberInRange(1, 1e9)(r.seconds) };
				} catch (err) {
					throw fail('bad_config', text('levels[{0}]: {1}', { 0: i, 1: errorText(err) }));
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
					throw fail('bad_config', text('"{0}": {1}', { 0: id, 1: errorText(err) }));
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
		// % faster construction in a settlement (e.g. from its seat of government); applied with the other time modifiers.
		stats.define({ id: 'buildings.speed', description: 'construction speed', percent: true, base: () => 0, min: 0 });
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

		/**
		 * Checks for moving buildings between `slots` of one district: two different slots of it, none being built.
		 * Production is banked first (a district's bonus is the same for every slot, but upkeep or effects may not be).
		 */
		async function relocating(api: EngineApi, settlementId: string, districtId: string, slots: number[]) {
			const s = await settlements.get(api, settlementId);
			const d = s?.districts.find((x) => x.id === districtId);
			if (!s || !d) throw fail('not_found', 'No such district', 404);
			if (new Set(slots).size !== slots.length) throw fail('bad_payload', 'Choose two different slots');
			for (const n of slots) if (n < 0 || n >= d.slots) throw fail('bad_payload', 'No such slot');
			await timeline.sync(api, settlements.entity(settlementId)); // what was due is built first
			const building = await loadConstruction(api, settlementId);
			if (slots.some((n) => building.has(key(districtId, n)))) throw fail('blocked', 'Not while it is being built');
			await resources.settle(api, settlements.entity(settlementId));
			const placed = (await loadPlaced(api, settlementId)).get(districtId) ?? new Map<number, Placed>();
			if (!(await loadPlaced(api, settlementId)).has(districtId)) (await loadPlaced(api, settlementId)).set(districtId, placed);
			return { placed };
		}

		/** A building's stat at `level`: `perLevel` x level, faster from its `statsGrowth` stages. */
		const statAt = (def: BuildingDef | undefined, perLevel: number, level: number) => stagedGrowth(perLevel, level, def?.statsGrowth);

		const effectLines = new Map<string, ((api: ReadApi, settlement: Settlement, level: number) => Promise<UiText[]>)[]>();
		/** `effectsAt` plus what other plugins say the building does (`addEffectLines`). */
		const describe = async (api: ReadApi, settlement: Settlement, def: BuildingDef, level: number): Promise<BuildingEffects> => {
			const lines: UiText[] = [];
			for (const f of effectLines.get(def.id) ?? []) lines.push(...(await f(api, settlement, level)));
			return { ...effectsAt(api, def, level), ...(lines.length ? { lines } : {}) };
		};
		/** Effect of one building at `level` under the current rules (production multiplier included). */
		const effectsAt = (api: ReadApi, def: BuildingDef, level: number): BuildingEffects => {
			const mult = productionMultiplier.get(api);
			return {
				produces: Object.fromEntries(Object.entries(def.produces ?? {}).map(([r, n]) => [r, n * level * mult])),
				stats: Object.fromEntries(Object.entries(def.stats ?? {}).map(([s, n]) => [s, statAt(def, n, level)])),
			};
		};

		const settlementOf = (holder: string) => (holder.startsWith('settlement:') ? holder.slice('settlement:'.length) : null);

		/* ----- service ------------------------------------------------------------------ */

		const capBonus = (api: ReadApi, settlementId: string, building: string) =>
			stats.get(api, capStat(building), settlements.entity(settlementId));

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
						statsGrowth: growthStages(row),
						costGrowth: row.costGrowth ? csvNumber(row, 'costGrowth') : undefined,
						timeGrowth: row.timeGrowth ? csvNumber(row, 'timeGrowth') : undefined,
						levels: rows,
					});
				}
			},
			define(def) {
				if (defs.has(def.id)) throw new PluginError(`Building "${def.id}" defined twice`);
				def = { ...def, name: ctx.services.get('i18n').own(def.name) };
				// Levels above the regular cap a settlement may reach (e.g. research), on every instance.
				stats.define({
					id: capStat(def.id),
					description: text('{0} level cap', { 0: keyText(def.name) }),
					base: () => 0,
					integer: true,
					min: 0,
				});
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
						// One line per kind of building (three farms are "Farm").
						const by = new Map<string, number>();
						for (const district of (await loadPlaced(api, id)).values()) {
							for (const p of district.values()) {
								const def = defs.get(p.building);
								const n = statAt(def, def?.stats?.[statId] ?? 0, p.level);
								if (n) by.set(p.building, (by.get(p.building) ?? 0) + n);
							}
						}
						return [...by].map(([b, flat]) => ({ flat, source: keyText(defs.get(b)!.name) }));
					});
				}
			},
			get(id) {
				const def = defs.get(id);
				if (!def) throw fail('unknown_building', text('Unknown building "{0}"', { 0: id }));
				return def;
			},
			list: () => [...defs.values()],
			addGate: (g) => void gates.push(g),

			levelCost(api, id, level) {
				const r = rules.get(api)[id];
				if (!r) throw fail('unknown_building', text('Unknown building "{0}"', { 0: id }));
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
				if (!template.accepts.includes(def.category)) return text('{0} cannot be built in this district', { 0: keyText(def.name) });
				if (def.kinds && !def.kinds.includes(settlement.kind))
					return text('{0} can only be built in: {1}', {
						0: keyText(def.name),
						1: def.kinds.map((k) => keyText(settlements.kind(k).name)),
					});
				if (def.unique && req.fromLevel === 0) {
					const perDistrict = def.unique === 'district';
					const placed = await service.placed(api, settlement.id);
					const inProgress = await loadConstruction(api, settlement.id);
					const exists =
						[...placed.entries()].some(
							([d, slots]) => (!perDistrict || d === req.districtId) && [...slots.values()].some((p) => p.building === def.id),
						) || [...inProgress.values()].some((c) => c.building === def.id && (!perDistrict || c.districtId === req.districtId));
					if (exists) return text(perDistrict ? 'Only one {0} per district' : 'Only one {0} per settlement', { 0: keyText(def.name) });
				}
				const instance = (await service.placed(api, settlement.id)).get(req.districtId)?.get(req.slot);
				const cap = (instance?.cap ?? rules.get(api)[def.id].cap) + (await capBonus(api, settlement.id, def.id));
				if (toLevel > cap) return text('Level cap {0} reached', { 0: cap });
				for (const gate of gates) {
					const reason = await gate(api, req);
					if (reason) return reason;
				}
				return null;
			},

			addDistrictBonus: (fn, source) => void districtBonuses.push({ fn, ...(source ? { source } : {}) }),
			addTimeModifier: (fn, source) => void timeModifiers.push({ fn, ...(source ? { source } : {}) }),
			async timeFactors(api, req) {
				// The speed stat (percent faster) by its own sources: +25% speed takes 1/1.25 of the time.
				const speedParts = (await stats.breakdown(api, 'buildings.speed', settlements.entity(req.settlement.id))).parts;
				const out = speedParts.map((p) => ({ source: p.source, factor: 1 / (1 + (p.flat + p.percent) / 100) }));
				for (const m of timeModifiers) out.push({ source: m.source, factor: await m.fn(api, req) } as FactorPart);
				return stats.factorParts(out);
			},
			async quote(api, req) {
				const { cost, seconds } = service.levelCost(api, req.building.id, req.toLevel);
				let factor = 1 / (1 + (await stats.get(api, 'buildings.speed', settlements.entity(req.settlement.id))) / 100);
				for (const m of timeModifiers) factor *= await m.fn(api, req);
				return { cost, seconds: Math.max(1, Math.ceil(seconds * Math.max(0, factor))) };
			},
			capOf: async (api, settlementId, p) => (p.cap ?? rules.get(api)[p.building].cap) + (await capBonus(api, settlementId, p.building)),
			async speedUp(api, settlementId, seconds) {
				await service.placed(api, settlementId); // what is due first
				const c = [...(await loadConstruction(api, settlementId)).values()].sort((a, b) => a.finishesAt - b.finishesAt)[0];
				if (!c) return false;
				const holder = settlements.entity(settlementId);
				c.finishesAt = Math.max(api.now, c.finishesAt - seconds * 1000);
				api.write(
					api.db
						.prepare('UPDATE buildings_construction SET finishes_at = ? WHERE district_id = ? AND slot = ?')
						.bind(c.finishesAt, c.districtId, c.slot),
				);
				timeline.cancelWhere(api, holder, COMPLETE, { districtId: c.districtId, slot: c.slot });
				timeline.schedule(api, holder, c.finishesAt, COMPLETE, {
					settlementId,
					districtId: c.districtId,
					slot: c.slot,
					building: c.building,
					level: c.targetLevel,
				});
				await timeline.sync(api, holder);
				return true;
			},
			addEffectLines(buildingId, f) {
				const list = effectLines.get(buildingId) ?? [];
				list.push(f);
				effectLines.set(buildingId, list);
			},
			async place(api, settlementId, districtId, slot, buildingId, level) {
				service.get(buildingId);
				const placed = await service.placed(api, settlementId);
				if (placed.get(districtId)?.get(slot)) throw fail('slot_taken', 'That slot already has a building');
				await resources.settle(api, settlements.entity(settlementId));
				if (!placed.has(districtId)) placed.set(districtId, new Map());
				const p: Placed = { building: buildingId, level, cap: null };
				placed.get(districtId)!.set(slot, p);
				writeSlot(api, settlementId, districtId, slot, p);
			},
			async move(api, settlementId, districtId, from, to) {
				const { placed } = await relocating(api, settlementId, districtId, [from, to]);
				const p = placed.get(from);
				if (!p) throw fail('not_found', 'No building in that slot', 404);
				if (placed.has(to)) throw fail('blocked', 'That slot is taken');
				placed.delete(from);
				placed.set(to, p);
				api.write(api.db.prepare('DELETE FROM buildings_slots WHERE district_id = ? AND slot = ?').bind(districtId, from));
				writeSlot(api, settlementId, districtId, to, p);
			},
			async swap(api, settlementId, districtId, a, b) {
				const { placed } = await relocating(api, settlementId, districtId, [a, b]);
				const pa = placed.get(a);
				const pb = placed.get(b);
				if (!pa || !pb) throw fail('not_found', 'No building in that slot', 404);
				placed.set(a, pb);
				placed.set(b, pa);
				writeSlot(api, settlementId, districtId, a, pb);
				writeSlot(api, settlementId, districtId, b, pa);
			},
			async raiseCap(api, settlementId, districtId, slot, by) {
				const p = (await service.placed(api, settlementId)).get(districtId)?.get(slot);
				if (!p) throw fail('not_found', 'No building in that slot', 404);
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
			const out: Record<string, { amount: number; percent: number; sources: ProductionSource[] }[]> = {};
			for (const [districtId, slots] of await loadPlaced(api, id)) {
				const produced: Record<string, number> = {};
				for (const p of slots.values()) {
					for (const [r, perLevel] of Object.entries(defs.get(p.building)?.produces ?? {}))
						produced[r] = (produced[r] ?? 0) + perLevel * p.level * mult;
				}
				if (!Object.keys(produced).length) continue;
				// Each district's production carries its own bonus (e.g. terrain), by resource.
				const bonus: Record<string, number> = {};
				const sources: Record<string, ProductionSource[]> = {};
				const district = settlement?.districts.find((d) => d.id === districtId);
				if (settlement && district)
					for (const b of districtBonuses)
						for (const [r, pct] of Object.entries(await b.fn(api, settlement, district))) {
							bonus[r] = (bonus[r] ?? 0) + pct;
							if (b.source && pct) (sources[r] ??= []).push({ source: b.source, percent: pct });
						}
				for (const [r, amount] of Object.entries(produced))
					(out[r] ??= []).push({ amount, percent: bonus[r] ?? 0, sources: sources[r] ?? [] });
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
			if (!Number.isInteger(slot) || slot < 0 || slot >= district.slots) throw fail('bad_slot', 'No such slot');
			const current = (await service.placed(api, settlement.id)).get(districtId)?.get(slot);
			if (current && buildingId && buildingId !== current.building) throw fail('slot_taken', 'That slot already has another building');
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
			parse: shape({ settlement: fields.id(), district: fields.id(), slot: fields.int(0, 1000), building: fields.optional(fields.id()) }),
			async execute(api, { settlement: settlementId, district, slot, building }) {
				const settlement = await settlements.requireOwned(api, settlementId);
				const req = await prepare(api, settlement, district, slot, building);
				if ((await loadConstruction(api, settlement.id)).has(key(district, slot))) throw fail('busy', 'Already under construction');
				const { used, size } = await queueState(api, settlement.id);
				if (used >= size) throw fail('queue_full', text('Construction queue full ({0}/{1})', { 0: used, 1: size }));
				const reason = await service.check(api, req);
				if (reason) throw fail('blocked', reason);

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
			parse: shape({ settlement: fields.id(), district: fields.id(), slot: fields.int(0, 1000) }),
			async execute(api, { settlement: settlementId, district, slot }) {
				const settlement = await settlements.requireOwned(api, settlementId);
				await service.placed(api, settlement.id); // process anything already due first
				const construction = await loadConstruction(api, settlement.id);
				const c = construction.get(key(district, slot));
				if (!c) throw fail('not_found', 'Nothing is being built there', 404);
				const holder = settlements.entity(settlement.id);
				const refund = cancelRefund.get(api);
				const back = Object.entries(service.levelCost(api, c.building, c.targetLevel).cost)
					.map(([r, n]) => [r, Math.floor(n * refund)] as const)
					.filter(([, n]) => n > 0);
				await resources.refund(api, holder, Object.fromEntries(back));
				construction.delete(key(district, slot));
				api.write(api.db.prepare('DELETE FROM buildings_construction WHERE district_id = ? AND slot = ?').bind(district, slot));
				timeline.cancelWhere(api, holder, COMPLETE, { districtId: district, slot });
			},
		});

		// The GM forms send one "settlement|district|slot" value; the API the three fields.
		const slotTarget = {
			target: fields.optional(fields.text({ max: 300 })),
			settlement: fields.optional(fields.id()),
			district: fields.optional(fields.id()),
			slot: fields.optional(fields.int(0, 1000)),
		};
		const targetSlot = (p: { target?: string; settlement?: string; district?: string; slot?: number }) => {
			const [settlement, district, slot] = p.target ? p.target.split('|') : [p.settlement, p.district, p.slot];
			if (!settlement || !district || !Number.isInteger(Number(slot))) throw fail('bad_payload', 'settlement and district are required');
			return { settlement, district, slot: Number(slot) };
		};

		ctx.commands.add<{ settlement: string; district: string; slot: number; by: number }>({
			type: 'buildings.raiseCap',
			form: {
				title: text('Raise a building level cap'),
				placement: 'gm',
				fields: [
					{ name: 'target', label: text('Building'), type: 'select', required: true },
					{ name: 'by', label: text('Levels'), type: 'number', required: true, min: 1, default: 1 },
				],
				submitLabel: text('Raise cap'),
				async prepare(api) {
					const options: { value: string; label: UiText }[] = [];
					for (const s of await settlements.mine(api, api.playerId)) {
						for (const d of s.districts) {
							for (const [slot, p] of (await service.placed(api, s.id)).get(d.id) ?? []) {
								options.push({
									value: `${s.id}|${d.id}|${slot}`,
									label: text('{0} · {1} Lv {2}/{3}', {
										0: settlements.nameText(s),
										1: keyText(service.get(p.building).name),
										2: p.level,
										3: await service.capOf(api, s.id, p),
									}),
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
			parse: shape({ ...slotTarget, by: fields.orElse(fields.int(1, 1000), 1) }, (p) => ({ ...targetSlot(p), by: p.by })),
			async execute(api, { settlement, district, slot, by }) {
				await settlements.requireOwned(api, settlement);
				await service.raiseCap(api, settlement, district, slot, Math.floor(by));
			},
		});

		ctx.commands.add<{ settlement: string; district: string; slot: number; level: number }>({
			type: 'buildings.setLevel',
			form: {
				title: text('Set a building level'),
				placement: 'gm',
				fields: [
					{ name: 'target', label: text('Building'), type: 'select', required: true },
					{ name: 'level', label: text('Level'), type: 'number', required: true, min: 1, default: 1 },
				],
				submitLabel: text('Set level'),
				async prepare(api) {
					const options: { value: string; label: UiText }[] = [];
					for (const s of await settlements.mine(api, api.playerId)) {
						for (const d of s.districts) {
							for (const [slot, p] of (await service.placed(api, s.id)).get(d.id) ?? []) {
								options.push({
									value: `${s.id}|${d.id}|${slot}`,
									label: text('{0} · {1} Lv {2}', { 0: settlements.nameText(s), 1: keyText(service.get(p.building).name), 2: p.level }),
								});
							}
						}
					}
					return options.length ? { options: { target: options } } : false;
				},
			},
			privileged: true,
			description:
				'Set an existing building to a level at once, ignoring caps, cost and time. Payload: { "settlement", "district", "slot", "level": 10 }',
			parse: shape({ ...slotTarget, level: fields.int(1, 10_000) }, (p) => ({ ...targetSlot(p), level: p.level })),
			async execute(api, { settlement, district, slot, level }) {
				await settlements.requireOwned(api, settlement);
				const p = (await service.placed(api, settlement)).get(district)?.get(slot);
				if (!p) throw fail('not_found', 'No building in that slot', 404);
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

			const option = async (req: UpgradeRequest, busy: UiText | null): Promise<BuildOption> => {
				const { cost, seconds } = await service.quote(api, req);
				const blocked = busy ?? (await service.check(api, req)) ?? undefined;
				return {
					building: req.building.id,
					level: req.toLevel,
					cost,
					seconds,
					effects: await describe(api, settlement, req.building, req.toLevel),
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
					const busy = c
						? text('Under construction')
						: used >= size
							? text('Construction queue full ({0}/{1})', { 0: used, 1: size })
							: null;
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
									effects: await describe(api, settlement, service.get(current.building), current.level),
									cap: await service.capOf(api, settlement.id, current),
								}
							: null,
						construction: c ? { building: c.building, targetLevel: c.targetLevel, startedAt: c.startedAt, finishesAt: c.finishesAt } : null,
						options,
					});
				}
				d.slots = slots;
			}
		});

		// The City page's slots (generic `ui.cards`): one card per slot of the district chosen on the district
		// board (filter "city.district"), with its building, construction, upgrade or what can be built.
		/**
		 * Construction-time factors in a settlement, for the first thing it could build (modifiers take a request;
		 * so far none depends on the building). None when nothing can be built.
		 */
		async function constructionFactors(api: EngineApi, d: SettlementDetail) {
			for (const district of d.districts)
				for (const s of district.slots)
					for (const o of s.options) {
						const settlement = await settlements.get(api, d.id);
						const building = defs.get(o.building);
						if (!settlement || !building) return [];
						const req = { settlement, districtId: district.id, slot: s.slot, building, fromLevel: o.level - 1, toLevel: o.level };
						return service.timeFactors(api, req);
					}
			return [];
		}

		// The same card heads the building's own entry ("building#<entry id>").
		ctx.views.add({
			id: 'buildings.slots',
			async compute(api, params): Promise<CardsData> {
				const d = await settlements.detail(api, params);
				if (!d) return { cards: [], empty: text('You have no settlement yet'), placement: 'settlement' };
				const icons = Object.fromEntries(resources.list().map((r) => [r.id, r.icon ?? r.id]));
				const statDefs = new Map(stats.list().map((s) => [s.id, s]));
				const hidden = new Set(stats.list().flatMap((s) => (s.hidden ? [s.id] : [])));
				// What the settlement has now: a short resource shows in red in the price.
				const have = await resources.amounts(api, settlements.entity(d.id));
				const effects = (e: BuildingEffects): UiText[] => [
					...Object.entries(e.produces).map(([r, n]) => literal(`${icons[r] ?? r} +${amount(n, 1)}/s`)),
					// "Equipment storage +20", "Construction speed +3%".
					...Object.entries(e.stats)
						.filter(([s]) => !hidden.has(s))
						.map(([s, n]) => {
							const stat = statDefs.get(s);
							const name = stat?.description ?? literal(s);
							return stat?.percent ? text('{1} +{0}%', { 0: amount(n, 2), 1: name }) : text('{1} +{0}', { 0: amount(n, 2), 1: name });
						}),
					...(e.lines ?? []),
				];
				// The price as button parts: each resource (red when short), then the time.
				const price = (o: BuildOption) => [...costParts(o.cost, icons, have), { text: literal(`· ${duration(o.seconds)}`) }];
				const why = (o: BuildOption) => o.blocked ?? (o.affordable ? undefined : text('Not enough resources'));
				const name = (id: string) => keyText(defs.get(id)?.name ?? id);
				const districtLabel = (type: string, idx: number): UiText =>
					type === 'inner' ? text('Inner city') : type === 'outer' ? text('Outer city {0}', { 0: idx }) : text('Fortress');
				const outer = d.districts.filter((x) => x.type === 'outer').length;
				const cards: UiCard[] = [];
				for (const district of d.districts)
					for (const s of district.slots) {
						const where = { settlement: d.id, district: district.id, slot: s.slot };
						const entryId = `${d.id}/${district.id}/${s.slot}`;
						const building = s.current?.building ?? s.construction?.building;
						const card: UiCard = {
							id: entryId,
							group: district.id,
							where: ['page:city', `building#${entryId}`],
							icon: s.current ? (defs.get(s.current.building)?.icon ?? '🏗️') : s.construction ? '🏗️' : undefined,
							title: s.current
								? text('{0} · Lv {1}/{2}', { 0: name(s.current.building), 1: s.current.level, 2: s.current.cap })
								: s.construction
									? name(s.construction.building)
									: text('Empty slot {0}', { 0: s.slot + 1 }),
							lines: [],
							actions: [],
						};
						const lines = card.lines!;
						const actions = card.actions!;
						if (s.current && effects(s.current.effects).length)
							lines.push({ text: text('Now: {0}', { 0: effects(s.current.effects) }), tone: 'info' });
						if (s.construction) {
							const c = s.construction;
							lines.push({ text: text('→ Lv {0}', { 0: c.targetLevel }), startedAt: c.startedAt, endsAt: c.finishesAt });
							actions.push({
								command: 'buildings.cancel',
								payload: where,
								label: text('Cancel'),
								confirm: text('Cancel this construction? Only part of the cost is refunded.'),
							});
						} else if (s.current) {
							for (const o of s.options) {
								actions.push({
									command: 'buildings.construct',
									payload: { ...where, building: o.building },
									label: text('Upgrade ·'),
									parts: price(o),
									...(why(o) ? { blocked: why(o)! } : {}),
								});
								if (effects(o.effects).length)
									lines.push({ text: text('Lv {0}: {1}', { 0: o.level, 1: effects(o.effects) }), tone: 'info' });
								if (o.blocked) lines.push({ text: o.blocked, tone: 'warn' });
							}
						} else if (s.options.length) {
							card.detail = {
								label: text('Build…'),
								choices: s.options.map((o) => ({
									lines: [
										...(effects(o.effects).length ? [{ text: text('{0}', { 0: effects(o.effects) }), tone: 'info' as const }] : []),
										...(o.blocked ? [{ text: o.blocked, tone: 'warn' as const } satisfies UiLine] : []),
									],
									action: {
										command: 'buildings.construct',
										payload: { ...where, building: o.building },
										label: text('{0} {1} ·', { 0: defs.get(o.building)?.icon ?? '🏗️', 1: name(o.building) }),
										parts: price(o),
										...(why(o) ? { blocked: why(o)! } : {}),
									},
								})),
							};
						}
						if (building)
							actions.push({
								entry: {
									kind: 'building',
									id: entryId,
									type: building,
									label: name(building),
									data: { settlement: d.id, district: district.id, slot: String(s.slot) },
								},
								label: text('Open'),
							});
						cards.push(card);
					}
				// Limits with where they come from on hover; construction time by source when anything changes it.
				const entity = settlements.entity(d.id);
				const sources = async (stat: string) => {
					const b = await stats.breakdown(api, stat, entity);
					return stats.describe(b.parts, { base: b.base });
				};
				const head: UiLine[] = [
					{ text: keyText(d.kindName) },
					{ text: text('({0}, {1})', { 0: d.x, 1: d.y }) },
					{
						text: text('build queue {0}/{1}', { 0: d.limits.queueUsed, 1: d.limits.queue }),
						hint: await sources('buildings.queue'),
					},
					...(outer
						? [{ text: text('outer cities {0}/{1}', { 0: outer, 1: d.limits.outerTech }), hint: await sources('settlements.outer.tech') }]
						: []),
					...(d.garrison ? [{ text: text('can garrison troops') }] : []),
				];
				const time = stats.factors(await constructionFactors(api, d));
				if (time.length) head.push({ text: text('Construction time: {0}', { 0: time }) });
				return {
					header: { title: keyText(d.name), lines: head.map((l) => ({ ...l, tone: 'muted' as const })) },
					groups: d.districts.length > 1 ? d.districts.map((x) => ({ id: x.id, label: districtLabel(x.type, x.idx) })) : undefined,
					defaultGroup: d.districts[0]?.id,
					cards,
					placement: 'settlement',
				};
			},
		});
		ctx.services
			.get('ui')
			.block({ page: 'city', column: 'right', widget: 'ui.cards', props: { view: 'buildings.slots', filter: 'city.district' } });
		// Opening a building: its own card first, then other plugins' blocks.
		ctx.services.get('ui').entry({ kind: 'building', widget: 'ui.cards', order: -100, props: { view: 'buildings.slots' } });

		const topParams = shape({
			building: fields.oneOf(() => [...defs.keys()]),
			min: fields.orElse(fields.int(0, 1e9), 1),
			limit: fields.orElse(fields.int(1, 500), 50),
		});
		ctx.reports.add({
			id: 'buildings.levels',
			description: 'Highest instances of a building type across all settlements.',
			example: { building: 'farm', min: 1, limit: 50 },
			async run(api, params) {
				const { building, min, limit } = topParams(params);
				const { results } = await api.db
					.prepare(
						'SELECT settlement_id AS settlement, district_id AS district, slot, level, cap FROM buildings_slots WHERE building = ? AND level >= ? ORDER BY level DESC LIMIT ?',
					)
					.bind(building, min, limit)
					.all();
				return results;
			},
		});
	},
});
