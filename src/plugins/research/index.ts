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
	type EngineApi,
	fields,
	gameErrors,
	numberFields,
	numberInRange,
	planRow,
	PluginError,
	type ReadApi,
	shape,
} from '../../kernel';
import type { ResearchJob, ResearchTree, TechInfo } from '../../shared/api';
import { costParts, duration, signed } from '../../shared/format';
import type { CardsData, TimersData, TreeData, TreeNode, UiCard, UiText, TreeNodePatch } from '../../shared/ui';
import type { LevelRow } from '../buildings';
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

/** What a tech does per level, for display (e.g. { target: "battle.attack", value: 3, percent: true }). */
export interface TechEffect {
	/** What it changes: a stat id, or a describer's own key (translated on the client as `effect:<target>`). */
	target: string;
	value: number;
	percent: boolean;
	/** Limited to one unit family, if any. */
	family?: string;
	/** That family's name, for the text (the describer knows it; research does not). */
	familyName?: string;
	/** A milestone: `value` once, from this tech level on (instead of `value` per level). */
	atLevel?: number;
}

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
/** Return a reason to block starting a research, or null. Must only read. */
/** A tech's hold on a building's levels: from tech level `level` on, the building may reach `from` and above. */
export interface TechUnlock {
	building: string;
	at: { level: number; from: number }[];
}

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
			for (const s of await settlements.mine(api, playerId)) await timeline.sync(api, settlements.entity(s.id));
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
		const techOwner = new Map<string, string>();
		/**
		 * A label key of the plugin that defined the tech. A runtime node has none: its effects are named by
		 * the stat they change, its tiers and branch by us.
		 */
		const labelOf = (tech: string, key: string, otherwise: () => UiText): UiText => {
			const owner = techOwner.get(tech);
			return owner ? keyText(`${owner}.${key}`) : otherwise();
		};
		// An effect on something that is no stat (e.g. a resource's output) shows its id.
		const effectLabel = (tech: string, target: string) =>
			labelOf(tech, `effect:${target}`, () => stats.list().find((s) => s.id === target)?.description ?? literal(target));
		const tierLabel = (tech: string, tier: string | number) => labelOf(tech, `research-tier:${tier}`, () => text(`research-tier:${tier}`));

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
					const { results } = await api.db
						.prepare('SELECT def, owner_id FROM research_nodes WHERE owner_id IS NULL OR owner_id = ? ORDER BY created_at')
						.bind(playerId)
						.all<{ def: string; owner_id: string | null }>();
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
				const { row, beyond } = planRow(def.levels, req.level);
				let costFactor = 1;
				let timeFactor = 1;
				for (const m of modifiers) {
					const f = await m.fn(api, req);
					costFactor *= f?.costFactor ?? 1;
					timeFactor *= f?.timeFactor ?? 1;
				}
				const labSpeed = await stats.get(api, 'research.speed', settlements.entity(req.settlementId));
				return {
					cost: Object.fromEntries(
						Object.entries(row.cost).map(([r, n]) => [r, Math.ceil(n * (def.costGrowth ?? growth.get(api).cost) ** beyond * costFactor)]),
					) as Cost,
					seconds: Math.max(
						1,
						Math.ceil((row.seconds * (def.timeGrowth ?? growth.get(api).time) ** beyond * timeFactor) / (speed.get(api) * labSpeed)),
					),
				};
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

		ctx.commands.add<{ tech: string; settlement: string }>({
			type: 'research.start',
			description: 'Start researching the next level of a tech in a settlement with an institute.',
			parse: shape({ tech: fields.id(), settlement: fields.id() }),
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
					return {
						options: {
							tech: [...(await service.techsFor(api, api.playerId)).values()].map((d) => ({
								value: d.id,
								label: text('{0} (Lv {1}/{2})', { 0: keyText(d.name), 1: lv.get(d.id) ?? 0, 2: d.maxLevel }),
							})),
						},
					};
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
				async prepare() {
					return {
						// One cost field per resource, whatever content plugins defined.
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

		async function treeOf(api: EngineApi, params: Record<string, string>): Promise<ResearchTree> {
			const lv = await levels(api, api.playerId);
			const queues = await loadQueues(api, api.playerId);
			const here = await settlements.resolve(api, params);
			const hasLab = here ? (await stats.get(api, 'research.labs', settlements.entity(here.id))) >= 1 : false;
			const techs = await Promise.all(
				[...(await service.techsFor(api, api.playerId)).values()].map(async (d) => {
					const level = lv.get(d.id) ?? 0;
					const next =
						level >= d.maxLevel || !here
							? null
							: {
									level: level + 1,
									...(await service.quote(api, { playerId: api.playerId, settlementId: here.id, tech: d.id, level: level + 1 })),
									blocked: (await blockedReason(api, api.playerId, here.id, d)) ?? undefined,
									locked: (await missingRequirement(api, api.playerId, d)) ?? undefined,
								};
					const effects: TechEffect[] = [
						...Object.entries(d.stats ?? {}).map(([target, value]) => ({ target, value, percent: false })),
						...Object.entries(d.percent ?? {}).map(([target, value]) => ({ target, value, percent: true })),
						...describers.flatMap((describe) => describe(api, api.playerId, d.id)),
					];
					return {
						id: d.id,
						name: d.name,
						description: d.description,
						level,
						maxLevel: d.maxLevel,
						next,
						branch: d.branch,
						tier: d.tier,
						order: d.order,
						quote: d.quote,
						requires: d.requires ?? {},
						unlocks: d.unlocks ?? [],
						effects,
					};
				}),
			);
			return {
				techs,
				current: here ? (queues.get(here.id) ?? null) : null,
				all: [...queues.values()],
				speed: here && hasLab ? (await stats.get(api, 'research.speed', settlements.entity(here.id))) * speed.get(api) : 0,
			};
		}
		const tree = (api: EngineApi, params: Record<string, string>) =>
			api.memo(`research:tree:${params.settlement ?? ''}`, () => treeOf(api, params));
		ctx.views.add({ id: 'research.tree', compute: (api, params) => tree(api, params) });

		// The same for the generic widgets: the research page's queue, and an institute's entry
		// (what it researches now; what can be researched there, by branch and tier).
		const techName = (t: ResearchTree, id: string) => keyText(t.techs.find((x) => x.id === id)?.name ?? id);
		const nameOf = async (api: ReadApi, settlementId: string) => (await settlements.get(api, settlementId))?.name ?? settlementId;
		const jobTimer = (t: ResearchTree, j: ResearchJob, where?: string) => ({
			id: j.settlement,
			title: text('{tech} {n}', { tech: techName(t, j.tech), n: j.targetLevel }),
			startedAt: j.startedAt,
			endsAt: j.finishesAt,
			...(where ? { lines: [{ text: keyText(where), tone: 'muted' as const }] } : {}),
		});
		ctx.views.add({
			id: 'research.queue',
			async compute(api, params): Promise<TimersData> {
				const t = await tree(api, params);
				const jobs = [...t.all].sort((a, b) => a.finishesAt - b.finishesAt);
				return {
					title: text('Research queue'),
					items: await Promise.all(jobs.map(async (j) => jobTimer(t, j, await nameOf(api, j.settlement)))),
					notes: jobs.length
						? []
						: [
								{
									text: text('Nothing is being researched. Start research at an institute (open it on the Overview page).'),
									tone: 'muted',
								},
							],
				};
			},
		});
		ctx.views.add({
			id: 'research.current',
			async compute(api, params): Promise<TimersData | null> {
				const here = await settlements.resolve(api, params);
				if (!here) return null;
				const t = await tree(api, params);
				return {
					title: text('Research here'),
					items: t.current ? [jobTimer(t, t.current)] : [],
					notes: [
						{
							text: text('Researching in {name} (speed ×{speed}); costs are paid by it.', {
								name: settlements.nameText(here),
								speed: t.speed.toFixed(2),
							}),
							tone: 'muted',
						},
						...(await speedNotes(api, here.id, t)),
					],
				};
			},
		});
		/** Where the speed, time and cost come from: "Speed: Institute +20%, ...", "Time: Heroes on duty −12%". */
		async function speedNotes(api: ReadApi, settlementId: string, t: ResearchTree) {
			if (!t.speed) return [];
			const b = await stats.breakdown(api, 'research.speed', settlements.entity(settlementId));
			const rule = speed.get(api);
			const speedParts = [
				...stats.describe(b.parts, { flatAsPercent: true }),
				...(rule !== 1 ? [text('All servers ×{0}', { 0: rule })] : []),
			];
			// Modifiers may depend on the tech: those of what runs here, else of the first tech (usually all alike).
			const tech = t.current?.tech ?? t.techs[0]?.id;
			const f = tech
				? await service.factors(api, {
						playerId: api.playerId,
						settlementId,
						tech,
						level: (t.techs.find((x) => x.id === tech)?.level ?? 0) + 1,
					})
				: { time: [], cost: [] };
			const lines: { text: UiText; tone: 'muted' }[] = [];
			if (speedParts.length) lines.push({ text: text('Speed: {0}', { 0: speedParts }), tone: 'muted' });
			const time = stats.factors(f.time);
			if (time.length) lines.push({ text: text('Research time: {0}', { 0: time }), tone: 'muted' });
			const cost = stats.factors(f.cost);
			if (cost.length) lines.push({ text: text('Research cost: {0}', { 0: cost }), tone: 'muted' });
			return lines;
		}

		/** "Attack +2.5% per level", "Archers only", "at Lv 3": the tech card's lines. */
		const effectText = (e: TechEffect, tech: string): UiText => {
			const vars = {
				effect: effectLabel(tech, e.target),
				value: signed(e.value, e.percent),
				...(e.familyName ? { family: keyText(e.familyName) } : {}),
				...(e.atLevel ? { lv: e.atLevel } : {}),
			};
			if (e.familyName)
				return text(e.atLevel ? '{effect} {value} (only {family}) at Lv {lv}' : '{effect} {value} (only {family}) per level', vars);
			return text(e.atLevel ? '{effect} {value} at Lv {lv}' : '{effect} {value} per level', vars);
		};
		/** What a tech's building nodes say: the one reached ("unlocked from level 6"), then the next ("Lv 3: from level 10"). */
		const unlockLines = (x: { level: number; unlocks: TechUnlock[] }): UiText[] =>
			x.unlocks.flatMap((u) => {
				const building = keyText(buildings.get(u.building)?.name ?? u.building);
				const reached = u.at.filter((n) => x.level >= n.level).at(-1);
				const next = u.at.find((n) => x.level < n.level);
				return [
					...(reached ? [text('Unlocked: {building} Lv {from} and above', { building, from: reached.from })] : []),
					...(next ? [text('Lv {lv}: unlocks {building} Lv {from} and above', { lv: next.level, building, from: next.from })] : []),
				];
			});
		ctx.views.add({
			id: 'research.options',
			async compute(api, params): Promise<CardsData | null> {
				const here = await settlements.resolve(api, params);
				if (!here) return null;
				const t = await tree(api, params);
				const icons = Object.fromEntries(resources.list().map((r) => [r.id, r.icon ?? r.id]));
				const holder = settlements.entity(here.id);
				const have = await resources.amounts(api, holder);
				// Only what can be researched now (prerequisites met, not maxed), one branch and tier at a time
				// (filter buttons "Civil · Foundation"…), each tech a card like the tree's; the whole tree is on the Research page.
				const open = t.techs.filter((x): x is TechInfo & { next: NonNullable<TechInfo['next']> } => !!x.next && !x.next.locked);
				const keys = [...new Set(open.map((x) => `${x.branch ?? 'Other'}|${x.tier ?? 1}`))].sort((a, b) => {
					const [ba, ta] = a.split('|');
					const [bb, tb] = b.split('|');
					return ba === bb ? Number(ta) - Number(tb) : 0;
				});
				const cards: UiCard[] = [];
				for (const x of [...open].sort((a, b) => (a.order ?? 0) - (b.order ?? 0))) {
					const affordable = await resources.canAfford(api, holder, x.next.cost);
					const blocked =
						x.next.blocked ??
						(t.current ? text('This settlement is researching another tech') : !affordable ? text('Not enough resources') : null);
					cards.push({
						id: x.id,
						group: `${x.branch ?? 'Other'}|${x.tier ?? 1}`,
						title: keyText(x.name),
						badge: text('Lv {n}/{max}', { n: x.level, max: x.maxLevel }),
						...(x.quote ? { quote: keyText(x.quote) } : {}),
						lines: [
							...unlockLines(x).map((t) => ({ text: t, tone: 'muted' as const })),
							...x.effects.map((e) => ({ text: effectText(e, x.id), tone: 'info' as const })),
							...(x.next.blocked ? [{ text: x.next.blocked, tone: 'warn' as const }] : []),
						],
						actions: [
							{
								command: 'research.start',
								payload: { tech: x.id, settlement: here.id },
								label: text('Research Lv {n} ·', { n: x.next.level }),
								// The price: each resource, red when short; then the time.
								parts: [...costParts(x.next.cost, icons, have), { text: literal(`· ${duration(x.next.seconds)}`) }],
								...(blocked ? { blocked } : {}),
							},
						],
					});
				}
				return {
					title: text('Research'),
					groups: keys.map((key) => {
						const [, tier] = key.split('|');
						const sample = open.find((x) => `${x.branch ?? 'Other'}|${x.tier ?? 1}` === key)!;
						return {
							id: key,
							label: text('{branch} · {tier}', {
								branch: sample.branch ? keyText(sample.branch) : text('Other'),
								tier: tierLabel(sample.id, tier),
							}),
						};
					}),
					...(keys.length ? { defaultGroup: keys[0] } : {}),
					cards,
					empty: text('Nothing can be researched right now. See the tech tree on the Research page.'),
				};
			},
		});

		/*
		 * The tech tree in two parts (AGENTS.md: what changes and what does not; user 2026-10-05: "科技树不需要传，本地缓存即可。
		 * 第一次传每个科技的等级，刷新时只传变化就够了。"). The tree every player has — branches, tiers, names, mottos, effects,
		 * prerequisites — is the static view `research.techs`, baked once per rules version; `research.graph` carries
		 * the player's part of each node (level, state, prerequisites met, unlocks, under way), no costs.
		 */
		const treeNode = (api: ReadApi, d: TechDef, all: Map<string, TechDef>): TreeNode => {
			const branch = (id: string) => all.get(id)?.branch ?? 'Other';
			const effects: TechEffect[] = [
				...Object.entries(d.stats ?? {}).map(([target, value]) => ({ target, value, percent: false })),
				...Object.entries(d.percent ?? {}).map(([target, value]) => ({ target, value, percent: true })),
				...describers.flatMap((describe) => describe(api, '', d.id)),
			];
			return {
				id: d.id,
				title: keyText(d.name),
				...(d.quote ? { quote: keyText(d.quote) } : {}),
				lines: effects.map((e) => ({ text: effectText(e, d.id) })),
				requires: Object.keys(d.requires ?? {})
					.filter((req) => branch(req) === branch(d.id))
					.map((req) => ({ id: req, met: false })),
				tags: Object.entries(d.requires ?? {})
					.filter(([req]) => branch(req) !== branch(d.id))
					.map(([req, level]) => ({
						id: req,
						text: text('{tech} {n}', { tech: keyText(all.get(req)?.name ?? req), n: level }),
						met: false,
					})),
			};
		};
		/** Branches of tiers of nodes, in the content's order. */
		const layout = (api: ReadApi, list: TechDef[], all: Map<string, TechDef>): TreeData['groups'] => {
			const branches: string[] = [];
			for (const x of list) if (!branches.includes(x.branch ?? 'Other')) branches.push(x.branch ?? 'Other');
			return branches.map((b) => {
				const techs = list.filter((x) => (x.branch ?? 'Other') === b);
				const tiers = Math.max(1, ...techs.map((x) => x.tier ?? 1));
				return {
					id: b,
					label: keyText(b),
					columns: Array.from({ length: tiers }, (_, i) => ({
						label: tierLabel(techs[0]?.id ?? '', i + 1),
						nodes: techs
							.filter((x) => (x.tier ?? 1) === i + 1)
							.sort((p, q) => (p.order ?? 0) - (q.order ?? 0))
							.map((x) => treeNode(api, x, all)),
					})),
				};
			});
		};
		ctx.statics.add({
			id: 'research.techs',
			async compute({ rules, db }): Promise<TreeData> {
				const api = rules as unknown as ReadApi;
				// The content's techs and those the GM added for everyone (not those added for one player).
				const all = new Map(defs);
				const { results } = await db
					.prepare('SELECT def FROM research_nodes WHERE owner_id IS NULL ORDER BY created_at')
					.all<{ def: string }>();
				for (const r of results) {
					const def = JSON.parse(r.def) as TechDef;
					if (!all.has(def.id)) all.set(def.id, def);
				}
				return {
					title: text('Tech tree'),
					groups: layout(api, [...all.values()], all),
					notes: [
						{
							text: text('Start research at an institute (open it on the Overview page). Tags: prerequisites in the other branch.'),
							tone: 'muted',
						},
					],
				};
			},
		});
		ctx.views.add({
			id: 'research.graph',
			async compute(api): Promise<TreeData> {
				const all = await service.techsFor(api, api.playerId);
				const own = personal.get(all) ?? new Set<string>();
				const lv = await levels(api, api.playerId);
				const researching = new Map([...(await loadQueues(api, api.playerId)).values()].map((j) => [j.tech, j.targetLevel]));
				const nodes: Record<string, TreeNodePatch> = {};
				for (const d of all.values()) {
					const level = lv.get(d.id) ?? 0;
					const missing = Object.entries(d.requires ?? {}).find(([req, n]) => (lv.get(req) ?? 0) < n);
					const active = researching.get(d.id);
					const unlocks = unlockLines({ level, unlocks: d.unlocks ?? [] });
					nodes[d.id] = {
						badge: text('{n}/{max}', { n: level, max: d.maxLevel }),
						state: active ? 'active' : level >= d.maxLevel ? 'done' : missing ? 'locked' : level ? 'started' : 'open',
						met: Object.entries(d.requires ?? {})
							.filter(([req, n]) => (lv.get(req) ?? 0) >= n)
							.map(([req]) => req),
						...(unlocks.length || active || missing
							? {
									lines: [
										...unlocks.map((t) => ({ text: t })),
										...(active
											? [{ text: text('Researching Lv {n}', { n: active }) }]
											: missing && level < d.maxLevel
												? [
														{
															text: text('Requires {0} Lv {1}', { 0: keyText(all.get(missing[0])?.name ?? missing[0]), 1: missing[1] }),
															tone: 'warn' as const,
														},
													]
												: []),
									],
								}
							: {}),
					};
				}
				// Techs added for this player alone: whole, as the static tree has not got them.
				const extra = [...all.values()].filter((d) => own.has(d.id));
				return { base: 'research.techs', groups: extra.length ? layout(api, extra, all) : [], nodes };
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
