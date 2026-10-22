/**
 * Research — the transparent tech tree. Technologies have per-player levels.
 *
 * Researching happens in settlements that have an institute (stat `research.labs` >= 1).
 * Each settlement has its own queue (one research at a time), but a player can never
 * research the same tech in two settlements at once (enforced by a UNIQUE key). Speed is
 * stat `research.speed` of that settlement (institute levels raise it). Costs are paid by
 * that settlement and follow a planning table like buildings.
 *
 * What a tech does is declared on it, using the extension points of other plugins:
 *   - `unlocks`: building level gates — e.g. { building: "farm", at: [{ level: 1, from: 6 }, { level: 3, from: 10 }] }:
 *     tech level 1 opens farms from level 6 on, level 3 from level 10 on
 *     means farm levels 6-10 need this tech at level 1, 11-15 at level 2, ...
 *   - `stats` / `percent`: bonuses per level for all the player's settlements.
 *
 * Hooks for future plugins:
 *   - `addCostModifier`: e.g. a hero leading research saves resources or time;
 *   - `grantLevel`: e.g. the opaque tech plugin (funding council projects) granting results;
 *   - `addGate`: extra conditions to start a tech (e.g. an opaque discovery required).
 */
import {
	csvLevels,
	csvRules,
	csvMap,
	csvNumber,
	csvRows,
	definePlugin,
	derive,
	type EngineApi,
	fields,
	gameErrors,
	numberFields,
	numberInRange,
	PluginError,
	type ReadApi,
	shape,
} from '../../kernel';
import type { ResearchHastenFormData, ResearchJob, ResearchState, TechLevelsFormData } from '../../shared/api';
import { type ResearchCatalog, type TechEffect, type TechPlan, type TechUnlock, techQuote, treeLayout } from '../../shared/research';
import type { TreeData, UiText } from '../../shared/ui';
import type { LevelRow } from '../buildings';
import type { Settlement } from '../settlements';
import type { Cost } from '../resources';
import type { Bonus, FactorPart } from '../stats';
import i18nCsv from './data/i18n.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import { keyText, literal, uiTexts } from '../../shared/i18n';

const fail = gameErrors('research');
const text = uiTexts('research');

export interface TechDef {
	id: string;
	name: string;
	description?: string;
	maxLevel: number;
	/** Planning table, index = level - 1 (level 1 required); missing levels grow from the nearest lower row. */
	levels: (LevelRow | null)[];
	costGrowth?: number;
	timeGrowth?: number;
	/** Required techs: tech id -> level needed before level 1 can start. */
	requires?: Record<string, number>;
	/** Building levels this tech unlocks, node by node (see file comment). */
	unlocks?: TechUnlock[];
	/** Flat stat bonus per tech level for the player's settlements. */
	stats?: Record<string, number>;
	/** Percent stat bonus per tech level for the player's settlements. */
	percent?: Record<string, number>;
	/** Where it sits in the tree: a branch (display name, e.g. "Civil"), a tier (1 = first) and an order within the tier. */
	branch?: string;
	tier?: number;
	order?: number;
	/** A line of flavour text (translated). */
	quote?: string;
}

export type { TechEffect, TechUnlock } from '../../shared/research';

/** Effects another plugin gives a tech (e.g. battle bonuses from a data table), for display. Must only read. */
export type EffectDescriber = (api: ReadApi, playerId: string, tech: string) => TechEffect[];

export interface ResearchRequest {
	playerId: string;
	settlementId: string;
	tech: string;
	level: number;
}

/** Multiplies cost and/or time of a research (e.g. 0.9 = 10% cheaper). Must only read. */
export type CostModifier = (api: ReadApi, request: ResearchRequest) => Promise<{ costFactor?: number; timeFactor?: number } | null>;
/** `unlockAt` of techs.csv: "1:6; 3:10; 7:15" (tech level: building level from). */
function unlockNodes(row: Record<string, string>): TechUnlock['at'] {
	const at = (row.unlockAt ?? '')
		.split(';')
		.map((x) => x.trim())
		.filter(Boolean)
		.map((x) => {
			const [level, from] = x.split(':').map((n) => Number(n.trim()));
			if (!Number.isInteger(level) || !Number.isInteger(from) || level < 1 || from < 1)
				throw new PluginError(`Tech "${row.id}": unlockAt needs "tech level:building level; ..." (got "${row.unlockAt}")`);
			return { level, from };
		});
	if (!at.length) throw new PluginError(`Tech "${row.id}" unlocks buildings but has no unlockAt`);
	return at.sort((a, b) => a.level - b.level);
}

/** Return a reason to block starting a research, or null. Must only read. */
export type ResearchGate = (api: EngineApi, request: ResearchRequest) => Promise<UiText | null>;

export interface ResearchService {
	define(def: TechDef): void;
	/**
	 * Define techs from CSV (see kernel/data.ts). `techs`: id, name, description, maxLevel,
	 * levels (id of a table in `levels`, default: the tech id), requires ("tech:level; ..."),
	 * unlocks ("building; ..."), unlockAt ("1:6; 3:10": tech level: building level from), stats / percent ("stat:n; ...").
	 * `levels`: id, level, seconds, one column per resource.
	 */
	defineFromCsv(techs: string, levels: string): void;
	list(): readonly TechDef[];
	level(api: EngineApi, playerId: string, tech: string): Promise<number>;
	/** Cost and time of `request.level` in `request.settlementId`, after speed and modifiers. */
	quote(api: ReadApi, request: ResearchRequest): Promise<LevelRow>;
	/** `source`: what players see it as in the breakdown of time and cost (e.g. "Heroes on duty"). */
	addCostModifier(modifier: CostModifier, source?: UiText): void;
	/** Where the time and cost factors of a request come from, one part per named source. */
	factors(api: ReadApi, request: ResearchRequest): Promise<{ time: FactorPart[]; cost: FactorPart[] }>;
	addGate(gate: ResearchGate): void;
	/** Set a tech level directly (settles the player's pools first). For rewards and GM tools. */
	grantLevel(api: EngineApi, playerId: string, tech: string, level: number): Promise<void>;
	/**
	 * Add a tech node at runtime (e.g. an opaque-tree discovery), stored as data. `ownerId`
	 * null = visible to everyone, otherwise only to that player. Afterwards it behaves like
	 * any tech: researchable, grantable, gating buildings and giving bonuses.
	 */
	registerNode(api: EngineApi, def: TechDef, options: { ownerId: string | null }): Promise<void>;
	/** Every tech a player can see: static ones plus runtime nodes. */
	techsFor(api: ReadApi, playerId: string): Promise<Map<string, TechDef>>;
	/**
	 * A building where research is started (e.g. the institute): the client puts the research
	 * controls on its entry (meta `researchLabs`). Research itself only needs stat `research.labs`.
	 */
	addLab(buildingId: string): void;
	/** A player's tech levels, read only (no due research processed): for bonuses computed while reading. */
	levelsOf(api: ReadApi, playerId: string): Promise<ReadonlyMap<string, number>>;
	/** Show effects a plugin gives techs (beyond `stats` / `percent`) on the tech cards. */
	addEffectDescriber(describer: EffectDescriber): void;
	/** Take `seconds` off the research running in a settlement (e.g. an item); at 0 it completes now. False if none. */
	speedUp(api: EngineApi, settlementId: string, seconds: number): Promise<boolean>;
}

declare module '../../kernel' {
	interface ServiceMap {
		research: ResearchService;
	}
}

const COMPLETE = 'research.complete';

/** What other plugins decide about researching in a settlement (`optionsOf`), stored for the flat `research.start`. */
export interface ResearchOptions {
	labs: number;
	labSpeed: number;
	/** By content tech: its next level, blocked or not, and the cost and time factors there. */
	techs: Record<string, { level: number; blocked: boolean; cost: number; time: number }>;
}

export default definePlugin({
	id: 'research',
	version: '0.2.0',
	description: 'Transparent tech tree: per-settlement queues in institutes, level gates, bonuses',
	dependsOn: ['buildings', 'settlements', 'resources', 'stats', 'timeline', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const buildings = ctx.services.get('buildings');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const stats = ctx.services.get('stats');
		const timeline = ctx.services.get('timeline');
		const defs = new Map<string, TechDef>();
		const contributed = new Set<string>();
		const modifiers: { fn: CostModifier; source?: UiText }[] = [];
		const gates: ResearchGate[] = [];

		const RULES = csvRules(rulesCsv) as { growth: { cost: number; time: number } };
		const growth = ctx.config.define('growth', {
			description:
				"Levels past a tech's table: each costs cost times, and takes time times, the one before (unless the tech gives its own).",
			default: () => RULES.growth,
			parse: numberFields(() => RULES.growth, 1, 10),
		});
		const speed = ctx.config.define('speed', {
			description: 'Global research speed multiplier (2 = twice as fast).',
			default: () => 1,
			parse: numberInRange(0.01, 1e6),
		});
		stats.define({ id: 'research.labs', description: 'research labs', base: () => 0, integer: true, min: 0, hidden: true });
		stats.define({ id: 'research.speed', description: 'research speed', base: () => 1, min: 0.01 });

		const loadLevels = (api: ReadApi, playerId: string) =>
			api.memo(
				`research:levels:${playerId}`,
				async () => {
					const { results } = await api.db
						.prepare('SELECT tech, level FROM research_levels WHERE player_id = ?')
						.bind(playerId)
						.all<{ tech: string; level: number }>();
					return new Map(results.map((r) => [r.tech, r.level]));
				},
				{ current: true },
			);
		// The player's levels: read by almost everything a settlement does (bonuses, caps, speeds).
		settlements.addPreload((api) => void loadLevels(api, api.playerId).catch(() => {}));
		/** Running research by settlement id. */
		const loadQueues = (api: ReadApi, playerId: string) =>
			api.memo(`research:queues:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT settlement_id, tech, target_level, started_at, finishes_at FROM research_queue WHERE player_id = ?')
					.bind(playerId)
					.all<{ settlement_id: string; tech: string; target_level: number; started_at: number; finishes_at: number }>();
				return new Map<string, ResearchJob>(
					results.map((r) => [
						r.settlement_id,
						{ settlement: r.settlement_id, tech: r.tech, targetLevel: r.target_level, startedAt: r.started_at, finishesAt: r.finishes_at },
					]),
				);
			});
		/** Levels with every due research applied (research completes in settlement timelines). */
		async function levels(api: EngineApi, playerId: string) {
			const mine = await settlements.mine(api, playerId);
			timeline.preload(
				api as EngineApi,
				mine.map((s) => settlements.entity(s.id)),
			);
			for (const s of mine) await timeline.sync(api, settlements.entity(s.id));
			return loadLevels(api, playerId);
		}
		const writeLevel = (api: EngineApi, playerId: string, tech: string, level: number) =>
			api.write(
				api.db
					.prepare(
						'INSERT INTO research_levels (player_id, tech, level) VALUES (?, ?, ?) ON CONFLICT (player_id, tech) DO UPDATE SET level = excluded.level',
					)
					.bind(playerId, tech, level),
			);

		/** Validate a data-only tech definition (runtime nodes come from untrusted-ish generators). */
		function parseTechDef(raw: unknown): TechDef {
			const r = (raw ?? {}) as Record<string, unknown>;
			const invalid = (m: string): never => {
				throw fail('bad_tech', m);
			};
			if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(r.id)) invalid('id: 1-64 of a-z, 0-9, -');
			if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 60) invalid('name: 1-60 characters');
			const maxLevel = Number(r.maxLevel);
			if (!Number.isInteger(maxLevel) || maxLevel < 1 || maxLevel > 1000) invalid('maxLevel: 1-1000');
			if (!Array.isArray(r.levels) || !r.levels.length) invalid('levels: non-empty array');
			const levels = (r.levels as unknown[]).map((row, i) => {
				if (row === null && i > 0) return null; // grows from the nearest lower row
				const x = (row ?? {}) as Record<string, unknown>;
				const cost = Object.fromEntries(
					Object.entries((x.cost ?? {}) as Record<string, unknown>).map(([k, v]) => [k, numberInRange(0, 1e15)(v)]),
				);
				return { cost, seconds: numberInRange(1, 1e9)(x.seconds) };
			});
			const nums = (v: unknown, name: string) => {
				if (v === undefined) return undefined;
				if (typeof v !== 'object' || v === null) invalid(`${name}: object of numbers`);
				return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, n]) => [k, numberInRange(-1e9, 1e9)(n)]));
			};
			const unlocks =
				r.unlocks === undefined
					? undefined
					: (r.unlocks as unknown[]).map((u) => {
							const x = (u ?? {}) as Record<string, unknown>;
							if (typeof x.building !== 'string') invalid('unlocks[].building required');
							if (!Array.isArray(x.at) || !x.at.length) invalid('unlocks[].at: a list of { level, from }');
							const at = (x.at as Record<string, unknown>[]).map((n) => ({
								level: numberInRange(1, 1e6)(n?.level),
								from: numberInRange(1, 1e6)(n?.from),
							}));
							return { building: x.building as string, at: at.sort((a, b) => a.level - b.level) };
						});
			return {
				id: r.id as string,
				name: (r.name as string).trim(),
				description: typeof r.description === 'string' ? r.description.slice(0, 200) : undefined,
				maxLevel,
				levels,
				costGrowth: r.costGrowth === undefined ? undefined : numberInRange(1, 10)(r.costGrowth),
				timeGrowth: r.timeGrowth === undefined ? undefined : numberInRange(1, 10)(r.timeGrowth),
				requires: nums(r.requires, 'requires'),
				unlocks,
				stats: nums(r.stats, 'stats'),
				percent: nums(r.percent, 'percent'),
			};
		}

		// The techs giving each stat, by the tech list a player sees (one per call): a stat is asked for many times a
		// sync, and going through every tech each time was a fixed CPU cost.
		const givers = new WeakMap<Map<string, TechDef>, Map<string, TechDef[]>>();
		function giving(techs: Map<string, TechDef>, statId: string, kind: 'flat' | 'percent') {
			let index = givers.get(techs);
			if (!index) {
				index = new Map();
				for (const d of techs.values())
					for (const [k, values] of [
						['flat', d.stats],
						['percent', d.percent],
					] as const)
						for (const id of Object.keys(values ?? {})) {
							const list = index.get(`${k}:${id}`) ?? [];
							list.push(d);
							index.set(`${k}:${id}`, list);
						}
				givers.set(techs, index);
			}
			return index.get(`${kind}:${statId}`) ?? [];
		}

		/** Register (once per stat and kind) a contributor summing the bonuses of all techs a player sees. */
		function ensureContributors(def: TechDef) {
			for (const [statId, kind] of [
				...Object.keys(def.stats ?? {}).map((x) => [x, 'flat'] as const),
				...Object.keys(def.percent ?? {}).map((x) => [x, 'percent'] as const),
			]) {
				if (contributed.has(`${statId}:${kind}`)) continue;
				contributed.add(`${statId}:${kind}`);
				stats.contribute(statId, async (api, target) => {
					let owner: string | null = null;
					if (target.startsWith('player:')) owner = target.slice(7);
					else if (target.startsWith('settlement:')) owner = (await settlements.get(api, target.slice(11)))?.ownerId ?? null;
					if (!owner) return null;
					const lv = await loadLevels(api, owner);
					const out: Bonus[] = [];
					for (const d of giving(await service.techsFor(api, owner), statId, kind)) {
						const n = ((kind === 'flat' ? d.stats : d.percent)?.[statId] ?? 0) * (lv.get(d.id) ?? 0);
						if (n) out.push({ [kind]: n, source: text('{0} Lv {1}', { 0: keyText(d.name), 1: lv.get(d.id)! }) });
					}
					return out;
				});
			}
		}

		const known = async (api: ReadApi, playerId: string, tech: string) => {
			const def = (await service.techsFor(api, playerId)).get(tech);
			if (!def) throw fail('unknown_tech', text('Unknown tech "{0}"', { 0: tech }));
			return def;
		};

		const labs = new Set<string>();
		ctx.meta.add('researchLabs', () => [...labs]);
		// Names by id, e.g. for GM rules keyed by tech.
		ctx.meta.add('techs', () => [...defs.values()].map(({ id, name }) => ({ id, name })));

		const describers: EffectDescriber[] = [];
		// The plugin that defined each tech: the labels of its effects and tiers are its keys (src/shared/research.ts).
		const techOwner = new Map<string, string>();
		/** A tech as both ends work it out: its effects (`stats` / `percent`, then the describers') and who defined it. */
		const planOf = (api: ReadApi, playerId: string, d: TechDef): TechPlan => {
			const owner = techOwner.get(d.id);
			return {
				id: d.id,
				name: d.name,
				...(d.description ? { description: d.description } : {}),
				maxLevel: d.maxLevel,
				levels: d.levels,
				...(d.costGrowth !== undefined ? { costGrowth: d.costGrowth } : {}),
				...(d.timeGrowth !== undefined ? { timeGrowth: d.timeGrowth } : {}),
				...(d.requires ? { requires: d.requires } : {}),
				...(d.unlocks ? { unlocks: d.unlocks } : {}),
				...(d.branch ? { branch: d.branch } : {}),
				...(d.tier !== undefined ? { tier: d.tier } : {}),
				...(d.order !== undefined ? { order: d.order } : {}),
				...(d.quote ? { quote: d.quote } : {}),
				effects: [
					...Object.entries(d.stats ?? {}).map(([target, value]) => ({ target, value, percent: false })),
					...Object.entries(d.percent ?? {}).map(([target, value]) => ({ target, value, percent: true })),
					...describers.flatMap((describe) => describe(api, playerId, d.id)),
				],
				...(owner ? { owner } : {}),
			};
		};
		/** What the cost modifiers multiply a request's cost and time by. */
		async function modifierFactors(api: ReadApi, req: ResearchRequest) {
			let cost = 1;
			let time = 1;
			for (const m of modifiers) {
				const f = await m.fn(api, req);
				cost *= f?.costFactor ?? 1;
				time *= f?.timeFactor ?? 1;
			}
			return { cost, time };
		}

		/** Of a player's techs (`techsFor`), those added for that player alone (not in the shared tree). */
		const personal = new WeakMap<Map<string, TechDef>, Set<string>>();
		const service: ResearchService = {
			addLab: (id) => void labs.add(id),
			levelsOf: (api, playerId) => loadLevels(api, playerId),
			addEffectDescriber: (d) => void describers.push(d),
			async speedUp(api, settlementId, seconds) {
				const owner = (await settlements.get(api, settlementId))?.ownerId;
				if (!owner) return false;
				const holder = settlements.entity(settlementId);
				await timeline.sync(api, holder); // what is due first
				const job = (await loadQueues(api, owner)).get(settlementId);
				if (!job) return false;
				job.finishesAt = Math.max(api.now, job.finishesAt - seconds * 1000);
				api.write(api.db.prepare('UPDATE research_queue SET finishes_at = ? WHERE settlement_id = ?').bind(job.finishesAt, settlementId));
				timeline.cancelWhere(api, holder, COMPLETE, { settlementId, tech: job.tech });
				timeline.schedule(api, holder, job.finishesAt, COMPLETE, { playerId: owner, settlementId, tech: job.tech, level: job.targetLevel });
				await timeline.sync(api, holder);
				return true;
			},
			defineFromCsv(techsCsv, levelsCsv) {
				const tables = csvLevels(levelsCsv);
				for (const row of csvRows(techsCsv)) {
					const levels = tables.get(row.levels || row.id);
					if (!levels) throw new PluginError(`Tech "${row.id}": no levels table "${row.levels || row.id}"`);
					const unlocks = row.unlocks
						? row.unlocks
								.split(';')
								.map((b) => b.trim())
								.filter(Boolean)
						: [];
					service.define({
						id: row.id,
						name: row.name,
						description: row.description || undefined,
						branch: row.branch || undefined,
						tier: row.tier ? csvNumber(row, 'tier') : undefined,
						order: row.order ? csvNumber(row, 'order') : undefined,
						quote: row.quote || undefined,
						maxLevel: csvNumber(row, 'maxLevel'),
						levels,
						requires: row.requires ? csvMap(row.requires) : undefined,
						costGrowth: row.costGrowth ? csvNumber(row, 'costGrowth') : undefined,
						timeGrowth: row.timeGrowth ? csvNumber(row, 'timeGrowth') : undefined,
						unlocks: unlocks.length ? unlocks.map((building) => ({ building, at: unlockNodes(row) })) : undefined,
						stats: row.stats ? csvMap(row.stats) : undefined,
						percent: row.percent ? csvMap(row.percent) : undefined,
					});
				}
			},
			define(def) {
				if (defs.has(def.id)) throw new PluginError(`Tech "${def.id}" defined twice`);
				const own = ctx.services.get('i18n').own;
				// Labels of its effects and tiers ("effect:<stat>", "research-tier:<n>") are in the defining plugin's table too.
				techOwner.set(def.id, ctx.caller() ?? ctx.pluginId);
				def = {
					...def,
					name: own(def.name),
					...(def.description ? { description: own(def.description) } : {}),
					...(def.quote ? { quote: own(def.quote) } : {}),
					...(def.branch ? { branch: own(def.branch) } : {}),
				};
				if (!def.levels[0]) throw new PluginError(`Tech "${def.id}" needs a level-1 row`);
				defs.set(def.id, def);
				ensureContributors(def);
			},
			list: () => [...defs.values()],
			techsFor(api, playerId) {
				return api.memo(`research:techs:${playerId}`, async () => {
					const out = new Map(defs);
					const own = new Set<string>();
					// Read on every command and page: kept as a derived value (shared nodes come with a rules version, the
					// player's own with their commits).
					const results = await derive(api, `research:nodes:${playerId}`, { owner: playerId }, async () => {
						const { results } = await api.db
							.prepare('SELECT def, owner_id FROM research_nodes WHERE owner_id IS NULL OR owner_id = ? ORDER BY created_at')
							.bind(playerId)
							.all<{ def: string; owner_id: string | null }>();
						return results;
					});
					for (const r of results) {
						const def = JSON.parse(r.def) as TechDef;
						if (!out.has(def.id)) out.set(def.id, def);
						if (r.owner_id) own.add(def.id);
						ensureContributors(def); // this isolate may not have seen the node yet
					}
					personal.set(out, own);
					return out;
				});
			},
			async registerNode(api, raw, { ownerId }) {
				const def = parseTechDef(raw);
				if (defs.has(def.id)) throw fail('bad_tech', text('Tech "{0}" already exists', { 0: def.id }));
				api.write(
					api.db
						.prepare('INSERT INTO research_nodes (id, owner_id, def, created_at) VALUES (?, ?, ?, ?)')
						.bind(def.id, ownerId, JSON.stringify(def), api.now),
				);
				ensureContributors(def);
				// Make it visible to the rest of this command.
				if (ownerId) (await service.techsFor(api, ownerId)).set(def.id, def);
				// For everyone: the shared tree (static view research.techs) is baked again.
				else if (ctx.services.has('configStore')) ctx.services.get('configStore').touch?.(api);
			},
			async level(api, playerId, tech) {
				return (await levels(api, playerId)).get(tech) ?? 0;
			},
			async quote(api, req) {
				const def = await known(api, req.playerId, req.tech);
				const f = await modifierFactors(api, req);
				const labSpeed = await stats.get(api, 'research.speed', settlements.entity(req.settlementId));
				// The same math as the client's prices (src/shared/research.ts).
				return techQuote(
					def,
					req.level,
					{ growth: growth.get(api), speed: speed.get(api) },
					{ labSpeed, costFactor: f.cost, timeFactor: f.time },
				) as { cost: Cost; seconds: number };
			},
			addCostModifier: (fn, source) => void modifiers.push({ fn, ...(source ? { source } : {}) }),
			async factors(api, req) {
				const time: { source?: UiText; factor: number }[] = [];
				const cost: { source?: UiText; factor: number }[] = [];
				for (const m of modifiers) {
					const f = await m.fn(api, req);
					if (f?.timeFactor !== undefined) time.push({ source: m.source, factor: f.timeFactor });
					if (f?.costFactor !== undefined) cost.push({ source: m.source, factor: f.costFactor });
				}
				return { time: stats.factorParts(time), cost: stats.factorParts(cost) };
			},
			addGate: (g) => void gates.push(g),
			async grantLevel(api, playerId, tech, level) {
				await known(api, playerId, tech);
				// Production bonuses may change: settle every pool of the player first.
				for (const s of await settlements.mine(api, playerId)) await resources.settle(api, settlements.entity(s.id));
				(await levels(api, playerId)).set(tech, level);
				writeLevel(api, playerId, tech, level);
			},
		};
		ctx.services.provide('research', service);

		// The GM speeds up a player's research (user 2026-10-19: "GM也没提供玩家研究加速表单"), as marches and adventures.
		ctx.commands.add<{ settlement: string; seconds: number }>({
			type: 'research.hasten',
			privileged: true,
			description:
				'Speed up the research running in one of the player\'s settlements by `seconds`; 0 = finish it now. Payload: { "settlement": "<id>", "seconds": 600 }',
			form: {
				title: text('Speed up research'),
				placement: 'gm',
				fields: [
					{ name: 'settlement', label: text('Research'), type: 'select', required: true },
					{ name: 'minutes', label: text('Minutes to skip (0 = finish now)'), type: 'number', min: 0, default: 0 },
				],
				submitLabel: text('Speed up'),
				async prepare(api) {
					const running = [...(await loadQueues(api, api.playerId))].filter(([, j]) => j.finishesAt > api.now);
					if (!running.length) return false;
					const techs = await service.techsFor(api, api.playerId);
					const jobs: ResearchHastenFormData = [];
					for (const [id, j] of running) {
						const s = await settlements.get(api, id);
						const tech = techs.get(j.tech);
						jobs.push({
							value: id,
							settlement: s ? settlements.nameText(s) : literal(id),
							tech: tech ? keyText(tech.name) : literal(j.tech),
							level: j.targetLevel,
							minutes: Math.ceil((j.finishesAt - api.now) / 60_000),
						});
					}
					// Worded by the browser (web/plugins/research/forms.ts).
					return { data: { 'research.hasten': jobs } };
				},
			},
			// Seconds through the API, minutes from the GM form; 0 = finish now.
			parse: shape(
				{ settlement: fields.id(), seconds: fields.optional(fields.number(0, 1e9)), minutes: fields.optional(fields.number(0, 1e7)) },
				(p) => ({ settlement: p.settlement, seconds: p.seconds ?? (p.minutes ?? 0) * 60 }),
			),
			async execute(api, { settlement, seconds }) {
				await settlements.requireOwned(api, settlement);
				if (!(await service.speedUp(api, settlement, seconds > 0 ? seconds : 1e12)))
					throw fail('not_found', 'Nothing is being researched there', 404);
			},
		});

		// Building gates: a level inside a tech's band needs that tech at the band's index.
		buildings.addGate(async (api, req) => {
			const owner = req.settlement.ownerId;
			if (!owner) return null;
			for (const def of (await service.techsFor(api, owner)).values()) {
				for (const u of def.unlocks ?? []) {
					if (u.building !== req.building.id) continue;
					// The node of the highest building level reached: its tech level is needed.
					const needed = u.at.filter((n) => req.toLevel >= n.from).at(-1)?.level;
					if (needed && (await service.level(api, owner, def.id)) < needed)
						return text('Requires {0} Lv {1}', { 0: keyText(def.name), 1: needed });
				}
			}
			return null;
		});

		// The same, for the city page's static cards: the content's techs as conditions on counters the client checks
		// (a tech added at runtime only shows when the server refuses), and the owner's levels of those techs.
		// Content plugins define techs after this setup: looked up when used.
		const gating = () => [...defs.values()].filter((d) => d.unlocks?.length);
		buildings.addCatalogNeeds((_rules, building) =>
			gating().flatMap((def) =>
				(def.unlocks ?? [])
					.filter((u) => u.building === building.id)
					.flatMap((u) =>
						u.at.map((n) => ({
							from: n.from,
							need: {
								counter: `research:${def.id}`,
								amount: n.level,
								short: text('Requires {0} Lv {1}', { 0: keyText(def.name), 1: n.level }),
							},
						})),
					),
			),
		);
		buildings.addCounters(async (api, settlement) => {
			const owner = settlement.ownerId;
			if (!owner) return {};
			const out: Record<string, number> = {};
			for (const def of gating()) out[`research:${def.id}`] = await service.level(api, owner, def.id);
			return out;
		});

		timeline.on<{ playerId: string; settlementId: string; tech: string; level: number }>(COMPLETE, async (api, event) => {
			const { playerId, settlementId, tech, level } = event.payload;
			// The finishing settlement's pool was advanced to this moment; settle the player's
			// other pools too, since a production bonus may start now.
			for (const s of await settlements.mine(api, playerId)) await resources.settle(api, settlements.entity(s.id));
			(await loadLevels(api, playerId)).set(tech, Math.max(level, (await loadLevels(api, playerId)).get(tech) ?? 0));
			(await loadQueues(api, playerId)).delete(settlementId);
			writeLevel(api, playerId, tech, level);
			api.write(api.db.prepare('DELETE FROM research_queue WHERE settlement_id = ?').bind(settlementId));
		});

		/** The first prerequisite tech the player still lacks for `def`, as a reason, or null. */
		async function missingRequirement(api: EngineApi, playerId: string, def: TechDef): Promise<UiText | null> {
			const lv = await levels(api, playerId);
			for (const [req, n] of Object.entries(def.requires ?? {})) {
				if ((lv.get(req) ?? 0) < n)
					return text('Requires {0} Lv {1}', { 0: keyText((await service.techsFor(api, playerId)).get(req)?.name ?? req), 1: n });
			}
			return null;
		}

		/** Why the next level of `tech` cannot start in settlement `settlementId`, or null. Ignores cost. */
		async function blockedReason(api: EngineApi, playerId: string, settlementId: string, def: TechDef): Promise<UiText | null> {
			const lv = await levels(api, playerId);
			const level = (lv.get(def.id) ?? 0) + 1;
			if (level > def.maxLevel) return text('Fully researched');
			if ((await stats.get(api, 'research.labs', settlements.entity(settlementId))) < 1)
				return text('Needs an institute in this settlement');
			const queues = await loadQueues(api, playerId);
			// One research per institute, and one tech in one settlement at a time.
			const here = queues.get(settlementId);
			if (here?.tech === def.id) return text('Being researched here');
			if (here) return text('This settlement is researching another tech');
			const elsewhere = [...queues.values()].find((j) => j.tech === def.id);
			if (elsewhere) {
				const there = await settlements.get(api, elsewhere.settlement);
				return there ? text('Being researched in {0}', { 0: settlements.nameText(there) }) : text('Being researched in another settlement');
			}
			const missing = await missingRequirement(api, playerId, def);
			if (missing) return missing;
			for (const gate of gates) {
				const reason = await gate(api, { playerId, settlementId, tech: def.id, level });
				if (reason) return reason;
			}
			return null;
		}

		/**
		 * What other plugins (and the player's other levels) decide about researching in a settlement, through their
		 * hooks, kept as a derived value (docs/development.md §2.3 "快速通道"): the flat `research.start` reads only this.
		 * By content tech: its next level, whether a requirement or a gate blocks it, and the cost and time factors.
		 * Not stale when events, amounts or the queue are written (read on the way; how many events are due is the salt).
		 */
		async function optionsOf(api: EngineApi, s: Settlement): Promise<ResearchOptions | null> {
			const owner = s.ownerId;
			if (!owner) return null;
			const mine = await settlements.mine(api, owner);
			timeline.preload(
				api,
				mine.map((x) => settlements.entity(x.id)),
			);
			let due = 0;
			for (const x of mine) due += await timeline.due(api, settlements.entity(x.id));
			const entity = settlements.entity(s.id);
			return derive(
				api,
				`research:options:${s.id}`,
				{ owner, salt: String(due), ignore: ['timeline_events', 'resources_balances', 'research_queue'] },
				async () => {
					const lv = await levels(api, owner);
					const out: ResearchOptions = {
						labs: await stats.get(api, 'research.labs', entity),
						labSpeed: await stats.get(api, 'research.speed', entity),
						techs: {},
					};
					for (const def of defs.values()) {
						const level = (lv.get(def.id) ?? 0) + 1;
						if (level > def.maxLevel) continue;
						const req = { playerId: owner, settlementId: s.id, tech: def.id, level };
						let blocked = !!(await missingRequirement(api, owner, def));
						if (!blocked) for (const gate of gates) if (await gate(api, req)) blocked = true;
						const f = await modifierFactors(api, req);
						out.techs[def.id] = { level, blocked, cost: f.cost, time: f.time };
					}
					return out;
				},
			);
		}

		ctx.commands.add<{ tech: string; settlement: string }>({
			type: 'research.start',
			description: 'Start researching the next level of a tech in a settlement with an institute.',
			parse: shape({ tech: fields.id(), settlement: fields.id() }),
			preload(api, { settlement }) {
				settlements.preload(api, [settlement]);
				buildings.preload(api, [settlement]);
				void loadQueues(api, api.playerId).catch(() => {});
				// Every institute's due events are processed first (`levels`): read with the list.
				void settlements
					.mine(api, api.playerId)
					.then((mine) =>
						timeline.preload(
							api,
							mine.map((s) => settlements.entity(s.id)),
						),
					)
					.catch(() => {});
			},
			// The common case on the fast path (a content tech, nothing of the player's due); the rest the regular way.
			flat: {
				derived: (p) => [{ key: `research:options:${p.settlement}`, salt: '0' }, resources.flat.derived(settlements.entity(p.settlement))],
				reads: (p, f) => ({
					...settlements.flatReads(f, p.settlement),
					// Research completes in any of the player's settlements: nothing of theirs may be due.
					due: f.db.prepare('SELECT COUNT(*) AS n FROM timeline_events WHERE player = ? AND due_at <= ?').bind(f.playerId, f.now),
					level: f.db.prepare('SELECT level FROM research_levels WHERE player_id = ? AND tech = ?').bind(f.playerId, p.tech),
					queue: f.db.prepare('SELECT settlement_id, tech FROM research_queue WHERE player_id = ?').bind(f.playerId),
					...resources.flat.reads(f, settlements.entity(p.settlement), f.playerId, 'pool:'),
				}),
				run(f) {
					const { payload: p, rows } = f;
					const s = settlements.flatSettlement(rows.row, rows.districts);
					const def = defs.get(p.tech);
					if (!s || s.ownerId !== f.playerId || !def || (rows.due[0] as { n: number }).n > 0) return null;
					const options = f.derived[`research:options:${p.settlement}`] as ResearchOptions;
					const level = ((rows.level[0] as { level: number } | undefined)?.level ?? 0) + 1;
					const opt = options.techs[p.tech];
					if (!opt || opt.level !== level || opt.blocked || options.labs < 1) return null;
					const queue = rows.queue as { settlement_id: string; tech: string }[];
					if (queue.some((j) => j.settlement_id === s.id || j.tech === p.tech)) return null;
					const { cost, seconds } = techQuote(
						def,
						level,
						{ growth: growth.get(f), speed: speed.get(f) },
						{ labSpeed: options.labSpeed, costFactor: opt.cost, timeFactor: opt.time },
					) as { cost: Cost; seconds: number };
					const holder = settlements.entity(s.id);
					const spent = resources.flat.spend(
						f,
						holder,
						f.playerId,
						'pool:',
						{ rows, numbers: f.derived[resources.flat.derived(holder).key] },
						cost,
					);
					if (!spent) return null;
					const finishesAt = f.now + seconds * 1000;
					return [
						...spent,
						f.db
							.prepare(
								'INSERT INTO research_queue (settlement_id, player_id, tech, target_level, started_at, finishes_at) VALUES (?, ?, ?, ?, ?, ?)',
							)
							.bind(s.id, f.playerId, p.tech, level, f.now, finishesAt),
						timeline.flatSchedule(
							f,
							holder,
							finishesAt,
							COMPLETE,
							{ playerId: f.playerId, settlementId: s.id, tech: p.tech, level },
							f.playerId,
						),
					];
				},
			},
			async execute(api, { tech, settlement }) {
				const def = await known(api, api.playerId, tech);
				const s = await settlements.requireOwned(api, settlement);
				const reason = await blockedReason(api, api.playerId, s.id, def);
				if (reason) throw fail('blocked', reason);
				const level = ((await levels(api, api.playerId)).get(tech) ?? 0) + 1;
				const { cost, seconds } = await service.quote(api, { playerId: api.playerId, settlementId: s.id, tech, level });
				await resources.spend(api, settlements.entity(s.id), cost);
				const job: ResearchJob = { settlement: s.id, tech, targetLevel: level, startedAt: api.now, finishesAt: api.now + seconds * 1000 };
				(await loadQueues(api, api.playerId)).set(s.id, job);
				api.write(
					api.db
						.prepare(
							'INSERT INTO research_queue (settlement_id, player_id, tech, target_level, started_at, finishes_at) VALUES (?, ?, ?, ?, ?, ?)',
						)
						.bind(s.id, api.playerId, tech, level, job.startedAt, job.finishesAt),
				);
				timeline.schedule(api, settlements.entity(s.id), job.finishesAt, COMPLETE, {
					playerId: api.playerId,
					settlementId: s.id,
					tech,
					level,
				});
			},
		});

		ctx.commands.add<{ tech: string; level: number }>({
			type: 'research.setLevel',
			form: {
				title: text('Set a tech level'),
				placement: 'gm',
				fields: [
					{ name: 'tech', label: text('Tech'), type: 'select', required: true },
					{ name: 'level', label: text('Level'), type: 'number', required: true, min: 0, default: 1 },
				],
				submitLabel: text('Set level'),
				async prepare(api) {
					const lv = await loadLevels(api, api.playerId);
					const techs: TechLevelsFormData = [...(await service.techsFor(api, api.playerId)).values()].map((d) => ({
						id: d.id,
						name: d.name,
						level: lv.get(d.id) ?? 0,
						max: d.maxLevel,
					}));
					return { data: { 'research.setLevel': techs } };
				},
			},
			privileged: true,
			description: 'Set a tech level directly. Payload: { "tech": "agriculture", "level": 3 }',
			parse: shape({ tech: fields.id(), level: fields.int(0, 1e6) }),
			execute: (api, { tech, level }) => service.grantLevel(api, api.playerId, tech, level),
		});

		ctx.commands.add<{ def: unknown; global: boolean }>({
			type: 'research.registerNode',
			form: {
				title: text('Register a new tech node'),
				description: text('A tech outside the tree (what an opaque-tree discovery creates). One cost row: later levels grow from it.'),
				placement: 'gm',
				fields: [
					{ name: 'id', label: text('Id (a-z, 0-9, -)'), type: 'text', required: true, maxLength: 64 },
					{ name: 'name', label: text('Name'), type: 'text', required: true, maxLength: 60 },
					{ name: 'maxLevel', label: text('Max level'), type: 'number', required: true, min: 1, default: 3 },
					{ name: 'seconds', label: text('Seconds per level'), type: 'number', required: true, min: 1, default: 600 },
					{ name: 'stat', label: text('Bonus to'), type: 'select' },
					{ name: 'percent', label: text('Bonus % per level'), type: 'number', default: 5 },
					{ name: 'global', label: text('Visible to everyone (otherwise only this player)'), type: 'checkbox' },
				],
				submitLabel: text('Register'),
				// The same for everyone, sent with the fixed part: one cost field per resource, whatever content plugins defined.
				fixed() {
					return {
						fields: resources.list().map((r) => ({
							name: `cost.${r.id}`,
							label: text('{0} per level', { 0: keyText(r.name) }),
							type: 'number' as const,
							min: 0,
						})),
						options: {
							stat: [{ value: '', label: text('—') }, ...stats.list().map((x) => ({ value: x.id, label: x.description }))],
						},
					};
				},
			},
			privileged: true,
			description:
				'Add a tech node at runtime (what the opaque tech plugin will do). Payload: { "def": { "id", "name", "maxLevel", "levels": [{ "cost": {}, "seconds": 60 }], "percent": { "resources.productionFactor": 5 } }, "global": false }',
			// A whole `def` through the API (checked by registerNode), or the GM form's fields.
			parse: shape(
				{
					def: fields.optional(fields.raw()),
					id: fields.optional(fields.text({ max: 64 })),
					name: fields.optional(fields.text({ max: 60 })),
					maxLevel: fields.optional(fields.int(1, 1000)),
					seconds: fields.optional(fields.number(1, 1e9)),
					cost: fields.orElse(fields.record(fields.orElse(fields.number(0, 1e12), 0)), {}),
					stat: fields.optional(fields.id()),
					percent: fields.orElse(fields.number(-1000, 1000), 0),
					global: fields.orElse(fields.bool(), false),
				},
				(p) => ({
					def: p.def ?? {
						id: p.id,
						name: p.name,
						maxLevel: p.maxLevel,
						levels: [{ cost: Object.fromEntries(Object.entries(p.cost).filter(([, n]) => n > 0)), seconds: p.seconds }],
						...(p.stat ? { percent: { [p.stat]: p.percent } } : {}),
					},
					global: p.global,
				}),
			),
			execute: (api, { def, global }) => service.registerNode(api, def as TechDef, { ownerId: global ? null : api.playerId }),
		});

		/*
		 * The tech tree as data (AGENTS.md: the server sends data, the browser assembles the display; user 2026-10-05:
		 * "科技树不需要传，本地缓存即可。第一次传每个科技的等级，刷新时只传变化就够了。"). The tree every player has — branches,
		 * tiers, names, mottos, effects, prerequisites, tables — is the static view `research.techs`, baked once per rules
		 * version (its `data`: the catalog the client quotes and words from); `research.state` carries the player's part:
		 * levels, what is being researched, and the selected settlement's labs, speed, cost and time factors and other
		 * plugins' gates. The tree, queue, cards and timers are worked out from them in the browser (web/plugins/research);
		 * whether a price can be paid too, by the resources the browser counts on (counters "resource:<id>"), so nothing
		 * here changes with time. Stamped: the player's commits (the tables it read), the rules, and the events due in
		 * the player's settlements (research completes in their timelines; a lab built here changes the labs).
		 */
		ctx.views.add({
			id: 'research.state',
			quiet: true,
			async stamp(api, params) {
				const mine = await settlements.mine(api, api.playerId);
				timeline.preload(
					api,
					mine.map((s) => settlements.entity(s.id)),
				);
				const due: number[] = [];
				for (const s of mine) due.push(await timeline.due(api, settlements.entity(s.id)));
				return `${await settlements.stamp(api, params)}|${due.join(',')}`;
			},
			async compute(api, params): Promise<ResearchState> {
				const lv = await levels(api, api.playerId);
				const queues = await loadQueues(api, api.playerId);
				const here = await settlements.resolve(api, params);
				const all = await service.techsFor(api, api.playerId);
				const own = personal.get(all) ?? new Set<string>();
				const jobs: ResearchState['jobs'] = [];
				for (const j of queues.values()) {
					const s = await settlements.get(api, j.settlement);
					jobs.push({ ...j, ...(s ? { name: s.name } : {}) });
				}
				const out: ResearchState = { levels: Object.fromEntries([...lv].filter(([, n]) => n > 0)), jobs, here: null };
				if (own.size) {
					out.own = [...all.values()].filter((d) => own.has(d.id)).map((d) => planOf(api, api.playerId, d));
					out.nodes = [...all.keys()].filter((id) => !defs.has(id));
				}
				if (!here) return out;
				// What the fast path of `research.start` reads, worked out (and stored) when stale.
				if (here.ownerId === api.playerId) await optionsOf(api, here);
				const entity = settlements.entity(here.id);
				const labs = await stats.get(api, 'research.labs', entity);
				const labSpeed = await stats.get(api, 'research.speed', entity);
				const factors: NonNullable<ResearchState['here']>['factors'] = { cost: 1, time: 1 };
				const reasons: Record<string, UiText> = {};
				let first = true;
				for (const d of all.values()) {
					const level = (lv.get(d.id) ?? 0) + 1;
					if (level > d.maxLevel) continue;
					const req = { playerId: api.playerId, settlementId: here.id, tech: d.id, level };
					// Modifiers may depend on the tech: one pair for all, and those of a tech that differs.
					const f = await modifierFactors(api, req);
					if (first) Object.assign(factors, f);
					else if (f.cost !== factors.cost || f.time !== factors.time) (factors.techs ??= {})[d.id] = f;
					first = false;
					// Other plugins' gates, as starting it would ask them: only when nothing of ours holds it back.
					if (labs < 1 || queues.has(here.id) || [...queues.values()].some((j) => j.tech === d.id)) continue;
					if (Object.entries(d.requires ?? {}).some(([r, n]) => (lv.get(r) ?? 0) < n)) continue;
					for (const gate of gates) {
						const reason = await gate(api, req);
						if (!reason) continue;
						reasons[d.id] = reason;
						break;
					}
				}
				out.here = {
					id: here.id,
					name: here.name,
					labs,
					labSpeed,
					factors,
					gates: reasons,
					...(labs >= 1 ? { sources: await sourcesOf(api, here.id, lv, all, queues.get(here.id)) } : {}),
				};
				return out;
			},
		});
		/** Where the speed, time and cost come from: "Speed: Institute +20%, ...", "Time: Heroes on duty −12%". */
		async function sourcesOf(
			api: EngineApi,
			settlementId: string,
			lv: ReadonlyMap<string, number>,
			all: Map<string, TechDef>,
			current: ResearchJob | undefined,
		) {
			const b = await stats.breakdown(api, 'research.speed', settlements.entity(settlementId));
			// Modifiers may depend on the tech: those of what runs here, else of the first tech (usually all alike).
			const tech = current?.tech ?? all.keys().next().value;
			const f = tech
				? await service.factors(api, { playerId: api.playerId, settlementId, tech, level: (lv.get(tech) ?? 0) + 1 })
				: { time: [], cost: [] };
			return { speed: b.parts, time: f.time.filter((x) => x.factor !== 1), cost: f.cost.filter((x) => x.factor !== 1) };
		}

		/** The shared tree's techs (the content's and those the GM added for everyone) and what quotes and lines need. */
		async function catalogOf(api: ReadApi, db: D1Database): Promise<ResearchCatalog> {
			const all = new Map(defs);
			const { results } = await db
				.prepare('SELECT def FROM research_nodes WHERE owner_id IS NULL ORDER BY created_at')
				.all<{ def: string }>();
			for (const r of results) {
				const def = JSON.parse(r.def) as TechDef;
				if (!all.has(def.id)) all.set(def.id, def);
			}
			return {
				growth: growth.get(api),
				speed: speed.get(api),
				techs: [...all.values()].map((d) => planOf(api, '', d)),
				buildings: Object.fromEntries(buildings.list().map((b) => [b.id, b.name])),
				icons: Object.fromEntries(resources.list().map((r) => [r.id, r.icon ?? r.id])),
				stats: Object.fromEntries(stats.list().map((x) => [x.id, x.description])),
			};
		}
		ctx.statics.add({
			id: 'research.techs',
			// Also the techs the GM added for everyone (a table): baked again with every rules version, which adding one moves on.
			content: true,
			async compute({ rules, db }): Promise<TreeData> {
				const catalog = await catalogOf(rules as unknown as ReadApi, db);
				const all = new Map(catalog.techs.map((t) => [t.id, t]));
				return {
					title: text('Tech tree'),
					groups: treeLayout(catalog.techs, all, catalog),
					notes: [
						{
							text: text('Start research at an institute (open it on the Overview page). Tags: prerequisites in the other branch.'),
							tone: 'muted',
						},
					],
					data: catalog,
				};
			},
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.page({ id: 'research', label: 'Research', order: 5 });
		ui.block({ page: 'research', column: 'left', widget: 'ui.timers', order: 10, props: { view: 'research.queue' } });
		ui.block({ page: 'research', column: 'right', widget: 'ui.tree', props: { view: 'research.graph' } });
		ui.entry({ kind: 'building', widget: 'ui.timers', order: -51, types: () => [...labs], props: { view: 'research.current' } });
		// What to research: a button per branch and tier, then that group's techs as cards.
		ui.entry({
			kind: 'building',
			widget: 'ui.filters',
			order: -50,
			types: () => [...labs],
			props: { view: 'research.options', filter: 'research.group', layout: 'row' },
		});
		ui.entry({
			kind: 'building',
			widget: 'ui.cards',
			order: -49,
			types: () => [...labs],
			props: { view: 'research.options', filter: 'research.group', layout: 'nodes' },
		});
	},
});
