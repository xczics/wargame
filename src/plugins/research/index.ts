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
 *   - `unlocks`: building level gates — e.g. { building: "farm", from: 6, perLevel: 5 }
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
	csvMap,
	csvNumber,
	csvRows,
	definePlugin,
	type EngineApi,
	GameError,
	numberInRange,
	planRow,
	PluginError,
	type ReadApi,
} from '../../kernel';
import type { ResearchJob, ResearchTree } from '../../shared/api';
import type { LevelRow } from '../buildings';
import type { Cost } from '../resources';

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
	/** Building level bands this tech unlocks (see file comment). */
	unlocks?: { building: string; from: number; perLevel: number }[];
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
export type ResearchGate = (api: EngineApi, request: ResearchRequest) => Promise<string | null>;

export interface ResearchService {
	define(def: TechDef): void;
	/**
	 * Define techs from CSV (see kernel/data.ts). `techs`: id, name, description, maxLevel,
	 * levels (id of a table in `levels`, default: the tech id), requires ("tech:level; ..."),
	 * unlocks ("building; ..."), unlockFrom, unlockPerLevel, stats / percent ("stat:n; ...").
	 * `levels`: id, level, seconds, one column per resource.
	 */
	defineFromCsv(techs: string, levels: string): void;
	list(): readonly TechDef[];
	level(api: EngineApi, playerId: string, tech: string): Promise<number>;
	/** Cost and time of `request.level` in `request.settlementId`, after speed and modifiers. */
	quote(api: ReadApi, request: ResearchRequest): Promise<LevelRow>;
	addCostModifier(modifier: CostModifier): void;
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
	dependsOn: ['buildings', 'settlements', 'resources', 'stats', 'timeline'],
	setup(ctx) {
		const buildings = ctx.services.get('buildings');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const stats = ctx.services.get('stats');
		const timeline = ctx.services.get('timeline');
		const defs = new Map<string, TechDef>();
		const contributed = new Set<string>();
		const modifiers: CostModifier[] = [];
		const gates: ResearchGate[] = [];

		const speed = ctx.config.define('speed', {
			description: 'Global research speed multiplier (2 = twice as fast).',
			default: () => 1,
			parse: numberInRange(0.01, 1e6),
		});
		stats.define({ id: 'research.labs', description: 'research labs', base: () => 0, integer: true, min: 0 });
		stats.define({ id: 'research.speed', description: 'research speed', base: () => 1, min: 0.01 });

		const loadLevels = (api: ReadApi, playerId: string) =>
			api.memo(`research:levels:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT tech, level FROM research_levels WHERE player_id = ?')
					.bind(playerId)
					.all<{ tech: string; level: number }>();
				return new Map(results.map((r) => [r.tech, r.level]));
			});
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
			const fail = (m: string): never => {
				throw new GameError('bad_tech', m);
			};
			if (typeof r.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(r.id)) fail('id: 1-64 of a-z, 0-9, -');
			if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 60) fail('name: 1-60 characters');
			const maxLevel = Number(r.maxLevel);
			if (!Number.isInteger(maxLevel) || maxLevel < 1 || maxLevel > 1000) fail('maxLevel: 1-1000');
			if (!Array.isArray(r.levels) || !r.levels.length) fail('levels: non-empty array');
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
				if (typeof v !== 'object' || v === null) fail(`${name}: object of numbers`);
				return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, n]) => [k, numberInRange(-1e9, 1e9)(n)]));
			};
			const unlocks =
				r.unlocks === undefined
					? undefined
					: (r.unlocks as unknown[]).map((u) => {
							const x = (u ?? {}) as Record<string, unknown>;
							if (typeof x.building !== 'string') fail('unlocks[].building required');
							return { building: x.building as string, from: numberInRange(1, 1e6)(x.from), perLevel: numberInRange(1, 1e6)(x.perLevel) };
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
					let sum = 0;
					for (const d of (await service.techsFor(api, owner)).values())
						sum += ((kind === 'flat' ? d.stats : d.percent)?.[statId] ?? 0) * (lv.get(d.id) ?? 0);
					return kind === 'flat' ? { flat: sum } : { percent: sum };
				});
			}
		}

		const known = async (api: ReadApi, playerId: string, tech: string) => {
			const def = (await service.techsFor(api, playerId)).get(tech);
			if (!def) throw new GameError('unknown_tech', `Unknown tech "${tech}"`);
			return def;
		};

		const labs = new Set<string>();
		ctx.meta.add('researchLabs', () => [...labs]);

		const describers: EffectDescriber[] = [];
		const service: ResearchService = {
			addLab: (id) => void labs.add(id),
			levelsOf: (api, playerId) => loadLevels(api, playerId),
			addEffectDescriber: (d) => void describers.push(d),
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
						unlocks: unlocks.length
							? unlocks.map((building) => ({ building, from: csvNumber(row, 'unlockFrom'), perLevel: csvNumber(row, 'unlockPerLevel') }))
							: undefined,
						stats: row.stats ? csvMap(row.stats) : undefined,
						percent: row.percent ? csvMap(row.percent) : undefined,
					});
				}
			},
			define(def) {
				if (defs.has(def.id)) throw new PluginError(`Tech "${def.id}" defined twice`);
				if (!def.levels[0]) throw new PluginError(`Tech "${def.id}" needs a level-1 row`);
				defs.set(def.id, def);
				ensureContributors(def);
			},
			list: () => [...defs.values()],
			techsFor(api, playerId) {
				return api.memo(`research:techs:${playerId}`, async () => {
					const out = new Map(defs);
					const { results } = await api.db
						.prepare('SELECT def FROM research_nodes WHERE owner_id IS NULL OR owner_id = ? ORDER BY created_at')
						.bind(playerId)
						.all<{ def: string }>();
					for (const r of results) {
						const def = JSON.parse(r.def) as TechDef;
						if (!out.has(def.id)) out.set(def.id, def);
						ensureContributors(def); // this isolate may not have seen the node yet
					}
					return out;
				});
			},
			async registerNode(api, raw, { ownerId }) {
				const def = parseTechDef(raw);
				if (defs.has(def.id)) throw new GameError('bad_tech', `Tech "${def.id}" already exists`);
				api.write(
					api.db
						.prepare('INSERT INTO research_nodes (id, owner_id, def, created_at) VALUES (?, ?, ?, ?)')
						.bind(def.id, ownerId, JSON.stringify(def), api.now),
				);
				ensureContributors(def);
				// Make it visible to the rest of this command.
				if (ownerId) (await service.techsFor(api, ownerId)).set(def.id, def);
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
					const f = await m(api, req);
					costFactor *= f?.costFactor ?? 1;
					timeFactor *= f?.timeFactor ?? 1;
				}
				const labSpeed = await stats.get(api, 'research.speed', settlements.entity(req.settlementId));
				return {
					cost: Object.fromEntries(
						Object.entries(row.cost).map(([r, n]) => [r, Math.ceil(n * (def.costGrowth ?? 1.4) ** beyond * costFactor)]),
					) as Cost,
					seconds: Math.max(1, Math.ceil((row.seconds * (def.timeGrowth ?? 1.3) ** beyond * timeFactor) / (speed.get(api) * labSpeed))),
				};
			},
			addCostModifier: (m) => void modifiers.push(m),
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
					if (u.building !== req.building.id || req.toLevel < u.from) continue;
					const needed = Math.floor((req.toLevel - u.from) / u.perLevel) + 1;
					if ((await service.level(api, owner, def.id)) < needed) return `Requires ${def.name} Lv ${needed}`;
				}
			}
			return null;
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
		async function missingRequirement(api: EngineApi, playerId: string, def: TechDef): Promise<string | null> {
			const lv = await levels(api, playerId);
			for (const [req, n] of Object.entries(def.requires ?? {})) {
				if ((lv.get(req) ?? 0) < n) return `Requires ${(await service.techsFor(api, playerId)).get(req)?.name ?? req} Lv ${n}`;
			}
			return null;
		}

		/** Why the next level of `tech` cannot start in settlement `settlementId`, or null. Ignores cost. */
		async function blockedReason(api: EngineApi, playerId: string, settlementId: string, def: TechDef): Promise<string | null> {
			const lv = await levels(api, playerId);
			const level = (lv.get(def.id) ?? 0) + 1;
			if (level > def.maxLevel) return 'Fully researched';
			if ((await stats.get(api, 'research.labs', settlements.entity(settlementId))) < 1) return 'Needs an institute in this settlement';
			const queues = await loadQueues(api, playerId);
			if (queues.has(settlementId)) return 'This settlement is already researching';
			const elsewhere = [...queues.values()].find((j) => j.tech === def.id);
			if (elsewhere) return `Being researched in ${(await settlements.get(api, elsewhere.settlement))?.name ?? 'another settlement'}`;
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
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.tech !== 'string') throw new GameError('bad_payload', 'tech is required');
				if (typeof p.settlement !== 'string') throw new GameError('bad_payload', 'settlement is required');
				return { tech: p.tech, settlement: p.settlement };
			},
			async execute(api, { tech, settlement }) {
				const def = await known(api, api.playerId, tech);
				const s = await settlements.requireOwned(api, settlement);
				const reason = await blockedReason(api, api.playerId, s.id, def);
				if (reason) throw new GameError('blocked', reason);
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
				title: 'Set a tech level',
				placement: 'gm',
				fields: [
					{ name: 'tech', label: 'Tech', type: 'select', required: true },
					{ name: 'level', label: 'Level', type: 'number', required: true, min: 0, default: 1 },
				],
				submitLabel: 'Set level',
				async prepare(api) {
					const lv = await loadLevels(api, api.playerId);
					return {
						options: {
							tech: [...(await service.techsFor(api, api.playerId)).values()].map((d) => ({
								value: d.id,
								label: `${d.name} (Lv ${lv.get(d.id) ?? 0}/${d.maxLevel})`,
							})),
						},
					};
				},
			},
			privileged: true,
			description: 'Set a tech level directly. Payload: { "tech": "agriculture", "level": 3 }',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (typeof p.tech !== 'string') throw new GameError('bad_payload', 'tech is required');
				return { tech: p.tech, level: Math.floor(numberInRange(0, 1e6)(p.level)) };
			},
			execute: (api, { tech, level }) => service.grantLevel(api, api.playerId, tech, level),
		});

		ctx.commands.add<{ def: unknown; global: boolean }>({
			type: 'research.registerNode',
			form: {
				title: 'Register a new tech node',
				description: 'A tech outside the tree (what an opaque-tree discovery creates). One cost row: later levels grow from it.',
				placement: 'gm',
				fields: [
					{ name: 'id', label: 'Id (a-z, 0-9, -)', type: 'text', required: true, maxLength: 64 },
					{ name: 'name', label: 'Name', type: 'text', required: true, maxLength: 60 },
					{ name: 'maxLevel', label: 'Max level', type: 'number', required: true, min: 1, default: 3 },
					{ name: 'seconds', label: 'Seconds per level', type: 'number', required: true, min: 1, default: 600 },
					{ name: 'stat', label: 'Bonus to', type: 'select' },
					{ name: 'percent', label: 'Bonus % per level', type: 'number', default: 5 },
					{ name: 'global', label: 'Visible to everyone (otherwise only this player)', type: 'checkbox' },
				],
				submitLabel: 'Register',
				async prepare() {
					return {
						// One cost field per resource, whatever content plugins defined.
						fields: resources.list().map((r) => ({ name: `cost:${r.id}`, label: `${r.name} per level`, type: 'number' as const, min: 0 })),
						options: { stat: [{ value: '', label: '—' }, ...stats.list().map((x) => ({ value: x.id, label: x.description }))] },
					};
				},
			},
			privileged: true,
			description:
				'Add a tech node at runtime (what the opaque tech plugin will do). Payload: { "def": { "id", "name", "maxLevel", "levels": [{ "cost": {}, "seconds": 60 }], "percent": { "resources.productionFactor": 5 } }, "global": false }',
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				if (p.def !== undefined) return { def: p.def, global: p.global === true };
				// Flat fields from the GM form.
				const def = {
					id: p.id,
					name: p.name,
					maxLevel: Number(p.maxLevel),
					levels: [
						{
							cost: Object.fromEntries(
								Object.entries(p)
									.filter(([k, v]) => k.startsWith('cost:') && Number(v) > 0)
									.map(([k, v]) => [k.slice('cost:'.length), Number(v)]),
							),
							seconds: Number(p.seconds),
						},
					],
					...(typeof p.stat === 'string' && p.stat ? { percent: { [p.stat]: Number(p.percent ?? 0) } } : {}),
				};
				return { def, global: p.global === true };
			},
			execute: (api, { def, global }) => service.registerNode(api, def as TechDef, { ownerId: global ? null : api.playerId }),
		});

		ctx.views.add({
			id: 'research.tree',
			async compute(api, params): Promise<ResearchTree> {
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
			},
		});
	},
});
