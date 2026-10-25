/**
 * Opaque research (docs/design/gameplay.md §14): bonuses without a cap, won by research projects whose outcome is
 * partly luck. Each player has 256 hidden values on a ring, in groups (as many as the GM likes); the GM gives each group one or
 * more bonuses with a percent a step; every threshold a value passes (8, 24, 72...: each a ratio of the one before) is one more step of its
 * group's bonuses.
 *
 * Heroes on the proposing duty write applications; the player approves them (paying, no refunds) where another
 * plugin says (a building: the stats `opaque-research.tier` and `opaque-research.concurrent`). An application is worked
 * out whenever it is looked at — from the hero, the season, the hidden values and the projects under way (seeded by
 * hero + season + version) — so nothing about it is stored; approving fixes where the project lands (a normal offset)
 * and its points; when it ends (timeline), the points go partly to the centre, partly to fill around it.
 *
 * This plugin knows no resources, buildings, duties or attributes: the wiring plugin says which duty proposes, which
 * attributes count, what a tier costs, which bonuses exist (each hooks itself where it applies) and the texts.
 */
import {
	csvRules,
	definePlugin,
	derive,
	type EngineApi,
	fields,
	gameErrors,
	numberFields,
	PluginError,
	type ReadApi,
	seededRandom,
	shape,
} from '../../kernel';
import type { OpaqueApplication, OpaqueGroup, OpaqueProject, OpaqueStatus, OpaqueTexts } from '../../shared/api';
import { uiTexts } from '../../shared/i18n';
import type { Hero } from '../heroes';
import { allocate, choose, DIMENSIONS, groupOf, groupSteps, offsetDraw, pointRange, sprintShare, type Tuning, wrapDim } from './logic';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

const fail = gameErrors('opaque-research');
const text = uiTexts('opaque-research');
const RULES = csvRules(rulesCsv) as Record<string, Record<string, number> | number>;
const nums = (key: string) => RULES[key] as Record<string, number>;

export interface OpaqueBonusDef {
	id: string;
	/** An i18n key of the defining plugin. */
	name: string;
	direction: 'increase' | 'decrease';
	/** The percent a step (one threshold passed in a group with it) the GM's editor suggests when adding it to a group. */
	step: number;
	/** Where the GM's editor lists it (e.g. "production", "upkeep", "time", "battle"). */
	category: string;
	/**
	 * Wire it where it applies: `percent(api, playerId)` is the player's total for it (a decrease: lower by the factor
	 * 1 / (1 + percent / 100), never to nothing; see `reduction` in src/shared/stats.ts).
	 */
	hook(percent: (api: ReadApi, playerId: string) => Promise<number>): void;
}
export interface OpaqueCosts {
	cost: Record<string, number>;
	seconds: number;
	yuanbao: number;
}
export interface OpaqueResearchService {
	defineBonus(def: OpaqueBonusDef): void;
	/**
	 * Which duty's heroes write applications, and how their attributes (equipment included) count: `points` and `sprint`
	 * give each attribute's weight (summing to 1 keeps the score on an attribute's scale), under the current rules.
	 */
	setProposers(p: {
		duty: string;
		points: (api: ReadApi) => Record<string, number>;
		sprint: (api: ReadApi) => Record<string, number>;
	}): void;
	/** The groups before the GM sets any (any number of them, 1 to 256; each its bonuses with a percent a step). Default: each bonus in turn at its step, 8 groups. */
	setDefaultGroups(groups: OpaqueGroup[]): void;
	/** What a tier's project costs (paid by the capital, no discounts) and how long it runs. */
	setCosts(costs: (api: ReadApi, tier: number) => OpaqueCosts): void;
	/** What applications are made of (sentences, code names, reviewers): content, sent to clients once. */
	setTexts(texts: Omit<OpaqueTexts, 'bonuses' | 'attributes' | 'groups'>): void;
}

declare module '../../kernel' {
	interface ServiceMap {
		opaqueResearch: OpaqueResearchService;
	}
}

interface ValuesRow {
	dims: number[];
	steps: number[];
	version: number;
	stored: boolean;
}
interface ProjectRow {
	id: string;
	player_id: string;
	hero_id: string;
	tier: number;
	target: number;
	offset: number;
	points: number;
	started_at: number;
	due_at: number;
}
interface HeroRow {
	hero_id: string;
	max_tier: number;
	hosted: number;
	rejected: string | null;
}

export default definePlugin({
	id: 'opaque-research',
	version: '0.1.0',
	description: 'Opaque research: hidden values, applications by heroes, projects with uncertain outcomes, bonuses without a cap',
	dependsOn: ['heroes', 'settlements', 'resources', 'shop', 'stats', 'timeline', 'i18n', 'ui'],
	tables: ['opaque_research_heroes', 'opaque_research_projects', 'opaque_research_values'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const heroes = ctx.services.get('heroes');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const shop = ctx.services.get('shop');
		const stats = ctx.services.get('stats');
		const timeline = ctx.services.get('timeline');
		const bonuses = new Map<string, OpaqueBonusDef>();
		let proposers: Parameters<OpaqueResearchService['setProposers']>[0] | null = null;
		let defaultGroups: OpaqueGroup[] | null = null;
		let costsOf: ((api: ReadApi, tier: number) => OpaqueCosts) | null = null;
		let texts: Omit<OpaqueTexts, 'bonuses' | 'attributes' | 'groups'> | null = null;

		/* ----- rules --------------------------------------------------------------------------- */

		/** First threshold and ratio (above 1, or the thresholds would never grow). */
		const thresholdsOf = (raw: unknown) => {
			const t = numberFields(() => nums('thresholds'), 0.01, 1e9)(raw);
			if (t.ratio < 1.1) throw fail('bad_config', 'The thresholds ratio must be at least 1.1');
			return t;
		};
		const tuning = ctx.config.define('tuning', {
			description:
				'The arithmetic: thresholds (first, then each ratio times the one before), points by tier, spread (points x a factor from min to max by the hero points score, full at that much; ± jitter), sprint (share on the centre: base + perCunning x (sprint score - 50) - lead x how far it leads; min, max; window filled each side), avoid (other projects: depth, sigma), fixedRate (review rate when nothing is promised).',
			default: () => ({
				thresholds: nums('thresholds'),
				points: nums('points'),
				spread: nums('spread'),
				sprint: nums('sprint'),
				avoid: nums('avoid'),
				fixedRate: RULES.fixedRate as number,
			}),
			parse(raw) {
				const r = (raw ?? {}) as Record<string, unknown>;
				return {
					thresholds: thresholdsOf(r.thresholds ?? {}),
					points: numberFields(() => nums('points'), 0, 1e6)(r.points ?? {}),
					spread: numberFields(() => nums('spread'), 0, 1e6)(r.spread ?? {}),
					sprint: numberFields(() => nums('sprint'), 0, 100)(r.sprint ?? {}),
					avoid: numberFields(() => nums('avoid'), 0, 100)(r.avoid ?? {}),
					fixedRate: r.fixedRate === undefined ? (RULES.fixedRate as number) : numberFields(() => ({ v: 0 }), 0, 1)({ v: r.fixedRate }).v,
				};
			},
		});
		const offsetRule = ctx.config.define('offset', {
			description: 'Where a project lands off its target: a normal draw of sigma dimensions, rounded, at most max either way.',
			default: () => nums('offset'),
			parse: numberFields(() => nums('offset'), 0, 8),
		});
		const levels = ctx.config.define('levels', {
			description: 'Hero level from which a hero applies for tier 2, 3 and 4 (below the first: tier 1).',
			default: () => nums('levels'),
			parse: numberFields(() => nums('levels'), 1, 10_000),
		});
		const seasons = ctx.config.define('seasons', {
			description: 'Days a season lasts, by tier: an application not approved is rewritten every season (UTC days).',
			default: () => nums('seasons'),
			parse: numberFields(() => nums('seasons'), 1, 365),
		});
		const exp = ctx.config.define('exp', {
			description: 'Experience a hero gets when a project of each tier ends.',
			default: () => nums('exp'),
			parse: numberFields(() => nums('exp'), 0, 1e9),
		});
		const groups = ctx.config.define<{ count: number; groups: OpaqueGroup[] }>('groups', {
			description:
				'The groups of the 256 dimensions (count: any from 1 to 256, runs round the ring in order, as even as can be) and what each gives: one or more bonuses, each with its percent a step (one threshold passed by a dimension of the group).',
			default: () => {
				if (defaultGroups) return { count: defaultGroups.length, groups: defaultGroups };
				const defs = [...bonuses.values()];
				return {
					count: 8,
					groups: Array.from({ length: 8 }, (_, i) =>
						defs.length ? [{ bonus: defs[i % defs.length].id, step: defs[i % defs.length].step }] : [],
					),
				};
			},
			parse(raw) {
				const part = fields.object({ bonus: fields.text({ max: 60 }), step: fields.number(0, 1000) });
				const r = shape({
					count: fields.int(1, DIMENSIONS),
					groups: fields.list(fields.list(part, { min: 0, max: 32 }), { min: 1, max: DIMENSIONS }),
				})(raw) as { count: number | string; groups: OpaqueGroup[] };
				const count = Number(r.count);
				if (r.groups.length !== count) throw fail('bad_config', text('One entry a group: {0} needed', { 0: count }));
				for (const g of r.groups) {
					for (const p of g) if (!bonuses.has(p.bonus)) throw fail('bad_config', text('Unknown bonus "{0}"', { 0: p.bonus }));
					if (new Set(g.map((p) => p.bonus)).size !== g.length) throw fail('bad_config', 'A bonus at most once a group');
				}
				return { count, groups: r.groups };
			},
		});
		/** Bonus -> [group, percent a step] of every group with it, built once a rule value. */
		const byBonus = new WeakMap<object, Map<string, [number, number][]>>();
		const indexOf = (g: { groups: OpaqueGroup[] }) => {
			let m = byBonus.get(g);
			if (!m) {
				m = new Map();
				g.groups.forEach((parts, i) => parts.forEach((p) => m!.set(p.bonus, [...(m!.get(p.bonus) ?? []), [i, p.step]])));
				byBonus.set(g, m);
			}
			return m;
		};
		const tune = (api: ReadApi): Tuning => {
			const t = tuning.get(api);
			return { ...t, thresholds: [t.thresholds.first, t.thresholds.ratio] } as unknown as Tuning;
		};

		stats.define({
			id: 'opaque-research.concurrent',
			description: 'research projects at a time',
			base: () => 0,
			integer: true,
			min: 0,
			hidden: true,
		});
		stats.define({
			id: 'opaque-research.tier',
			description: 'highest research project tier allowed',
			base: () => 0,
			integer: true,
			min: 0,
			max: 4,
			hidden: true,
		});

		/* ----- what is stored --------------------------------------------------------------------- */

		const valuesOf = (api: ReadApi, playerId: string) =>
			api.memo(`opaque:values:${playerId}`, async (): Promise<ValuesRow> => {
				// Its bonuses are asked on most commands and pages (build time, production...): kept as a derived value.
				const row = await derive(api, `opaque-research:values:${playerId}`, { owner: playerId }, () =>
					api.db
						.prepare('SELECT dims, steps, version FROM opaque_research_values WHERE player_id = ?')
						.bind(playerId)
						.first<{ dims: string; steps: string; version: number }>(),
				);
				return row
					? { dims: JSON.parse(row.dims), steps: JSON.parse(row.steps), version: row.version, stored: true }
					: { dims: Array<number>(DIMENSIONS).fill(0), steps: [], version: 0, stored: false };
			});
		const projectsOf = (api: ReadApi, playerId: string) =>
			api.memo(`opaque:projects:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT * FROM opaque_research_projects WHERE player_id = ?')
					.bind(playerId)
					.all<ProjectRow>();
				return results;
			});
		const heroRowsOf = (api: ReadApi, playerId: string) =>
			api.memo(`opaque:heroes:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT hero_id, max_tier, hosted, rejected FROM opaque_research_heroes WHERE player_id = ?')
					.bind(playerId)
					.all<HeroRow>();
				return new Map(results.map((r) => [r.hero_id, r]));
			});
		/** Moves the version on (applications are written again), creating the player's row if need be. */
		const saveValues = (api: EngineApi, playerId: string, v: ValuesRow) => {
			v.version += 1;
			v.stored = true;
			api.write(
				api.db
					.prepare(
						'INSERT INTO opaque_research_values (player_id, dims, steps, version) VALUES (?, ?, ?, ?) ON CONFLICT (player_id) DO UPDATE SET dims = excluded.dims, steps = excluded.steps, version = excluded.version',
					)
					.bind(playerId, JSON.stringify(v.dims), JSON.stringify(v.steps), v.version),
			);
		};
		const saveHero = (api: EngineApi, playerId: string, h: HeroRow) =>
			api.write(
				api.db
					.prepare(
						'INSERT INTO opaque_research_heroes (hero_id, player_id, max_tier, hosted, rejected) VALUES (?, ?, ?, ?, ?) ON CONFLICT (hero_id) DO UPDATE SET max_tier = excluded.max_tier, hosted = excluded.hosted, rejected = excluded.rejected',
					)
					.bind(h.hero_id, playerId, h.max_tier, h.hosted, h.rejected),
			);

		/* ----- bonuses ---------------------------------------------------------------------------- */

		/** A player's total percent for a bonus: the steps of every group it has, x its percent a step. */
		async function percentOf(api: ReadApi, playerId: string, bonus: string) {
			const g = groups.get(api);
			const at = indexOf(g).get(bonus);
			if (!at) return 0;
			const v = await valuesOf(api, playerId);
			if (!v.stored) return 0;
			// The stored steps are by the groups at the time; another count of groups: worked out again.
			const per = v.steps.length === g.count ? v.steps : groupSteps(v.dims, g.count, tune(api).thresholds);
			return at.reduce((n, [i, step]) => n + (per[i] ?? 0) * step, 0);
		}

		/* ----- applications ------------------------------------------------------------------------- */

		const tierOfLevel = (api: ReadApi, level: number) => {
			const l = levels.get(api);
			return level >= l['4'] ? 4 : level >= l['3'] ? 3 : level >= l['2'] ? 2 : 1;
		};
		const seasonOf = (api: ReadApi, tier: number) => Math.floor(api.now / ((seasons.get(api)[String(tier)] ?? 1) * 86_400_000));
		const topAttribute = (attrs: Record<string, number>) => Object.entries(attrs).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
		/** A weighted mix of attributes (several count, none alone). */
		const score = (attrs: Record<string, number>, weights: Record<string, number>) =>
			Object.entries(weights).reduce((n, [a, w]) => n + (attrs[a] ?? 0) * w, 0);
		/** The hero's scores for points and for the sprint, its equipment included. */
		const scores = async (api: ReadApi, hero: Hero) => {
			const attrs = await heroes.attributesOf(api, hero);
			return { attrs, points: score(attrs, proposers!.points(api)), sprint: score(attrs, proposers!.sprint(api)) };
		};

		/** The application a hero writes now (null: not writing one), worked out from what is stored. */
		async function applicationOf(api: ReadApi, hero: Hero, unlocked: number): Promise<OpaqueApplication | null> {
			if (!proposers || !costsOf || hero.duty !== proposers.duty) return null;
			const projects = await projectsOf(api, hero.playerId);
			if (projects.some((p) => p.hero_id === hero.id)) return null;
			const record = (await heroRowsOf(api, hero.playerId)).get(hero.id);
			const tier = Math.min(tierOfLevel(api, hero.level), (record?.max_tier ?? 0) + 1, unlocked);
			if (tier < 1) return null;
			const season = seasonOf(api, tier);
			if (record?.rejected === `${tier}:${season}`) return null;
			const values = await valuesOf(api, hero.playerId);
			const t = tune(api);
			const seed = `${hero.id}:${tier}:${season}:${values.version}`;
			const sc = await scores(api, hero);
			const range = pointRange(tier, sc.points, t);
			const centres = projects.map((p) => wrapDim(p.target + p.offset));
			const c = choose(values.dims, range, sc.sprint, centres, t, seededRandom(`opaque:${seed}`));
			const g = groups.get(api);
			const group = groupOf(c.target, g.count);
			const costs = costsOf(api, tier);
			return {
				hero: hero.id,
				heroName: heroes.nameKey(hero),
				tier,
				season,
				version: values.version,
				seed,
				target: c.target,
				group,
				promise: c.promise,
				rate: Math.round(c.rate * 100) / 100,
				tags: {
					progress: c.gap < 0.25 ? 'near' : c.gap < 0.6 ? 'mid' : 'far',
					lead: c.lead > 0.5 ? 'ahead' : c.lead < -0.5 ? 'behind' : 'even',
					attr: topAttribute(sc.attrs),
					tier: String(tier),
					promise: c.promise ? 'yes' : 'no',
					history: !record?.hosted ? 'none' : record.hosted < 3 ? 'some' : 'many',
					rate: c.rate >= 0.7 ? 'high' : c.rate >= 0.35 ? 'mid' : 'low',
				},
				cost: costs.cost,
				yuanbao: costs.yuanbao,
				seconds: costs.seconds,
			};
		}
		/** The stats are the capital's (where the approving building stands); no capital: nothing unlocked. */
		const capitalStat = async (api: ReadApi, playerId: string, stat: string) => {
			const capital = await settlements.capital(api, playerId);
			return capital ? stats.get(api, stat, settlements.entity(capital.id)) : 0;
		};
		const unlockedOf = (api: ReadApi, playerId: string) => capitalStat(api, playerId, 'opaque-research.tier');
		/** Projects due end first (their events are on the capital). */
		const syncEnds = async (api: EngineApi, playerId: string) => {
			const capital = await settlements.capital(api, playerId);
			if (capital) await timeline.sync(api, settlements.entity(capital.id));
		};

		ctx.views.add({
			id: 'opaque-research.status',
			quiet: true,
			// Changes with the player's commits (approvals, ends, duties), each day (seasons), a project falling due, the rules.
			stamp: async (api) => {
				const due = (await projectsOf(api, api.playerId)).filter((p) => p.due_at <= api.now).length;
				return `${await api.version(`player:${api.playerId}`)}|${Math.floor(api.now / 86_400_000)}|${due}|${api.rulesVersion ?? 0}`;
			},
			async compute(api): Promise<OpaqueStatus> {
				await syncEnds(api, api.playerId);
				const unlocked = await unlockedOf(api, api.playerId);
				const g = groups.get(api);
				const values = await valuesOf(api, api.playerId);
				// Nothing stored: every dimension at 0, no steps (not worked out from 256 zeros).
				const per = !values.stored
					? []
					: values.steps.length === g.count
						? values.steps
						: groupSteps(values.dims, g.count, tune(api).thresholds);
				const out: OpaqueStatus = {
					unlocked,
					running: 0,
					max: 0,
					applications: [],
					projects: [],
					steps: Array.from({ length: g.count }, (_, i) => per[i] ?? 0),
				};
				// No temple: nothing to work out (user 2026-10-18: "没建双清观就不要浪费算力了").
				if (!unlocked) return out;
				const projects = await projectsOf(api, api.playerId);
				const mine = await heroes.list(api, api.playerId);
				out.running = projects.length;
				out.max = await capitalStat(api, api.playerId, 'opaque-research.concurrent');
				// Each hero's application searches the dimensions (a few thousand steps): kept as a derived value, the same
				// until a season turns, a project falls due or what it reads (heroes, projects, values) changes.
				const seasons = Array.from({ length: unlocked }, (_, i) => seasonOf(api, i + 1)).join(',');
				const due = projects.filter((p) => p.due_at <= api.now).length;
				out.applications = await derive(
					api,
					`opaque-research:applications:${api.playerId}`,
					{ owner: api.playerId, salt: `${due}|${seasons}` },
					async () => {
						const list: OpaqueApplication[] = [];
						for (const h of await heroes.list(api, api.playerId)) {
							const a = await applicationOf(api, h, unlocked);
							if (a) list.push(a);
						}
						return list;
					},
				);
				out.projects = projects.map((p): OpaqueProject => {
					const h = mine.find((x) => x.id === p.hero_id);
					const group = groupOf(p.target, g.count);
					return {
						hero: p.hero_id,
						heroName: h ? heroes.nameKey(h) : '',
						tier: p.tier,
						group,
						startedAt: p.started_at,
						endsAt: p.due_at,
					};
				});
				return out;
			},
		});
		// Its own GM tab too: the groups and which dimensions (by code name) each holds.
		ctx.services.get('ui').slot({ slot: 'gm-tabs', widget: 'opaque-research.gm', props: { label: text('Opaque research') } });
		// The GM edits the groups on a ring (web plugin opaque-research), in place of the generic value editor.
		ctx.services
			.get('ui')
			.slot({ slot: 'gm-rule-editors', widget: 'opaque-research.gm-groups', props: { rule: 'opaque-research.groups' } });
		ctx.statics.add({
			id: 'opaque-research.texts',
			// The groups' layout is a rule: baked again when the GM changes it.
			compute: ({ rules }): OpaqueTexts => ({
				...(texts ?? { sentences: [], codes: [], reviewers: [] }),
				attributes: Object.fromEntries(heroes.attributes().map((a) => [a.id, a.name])),
				bonuses: Object.fromEntries(
					[...bonuses.values()].map((b) => [b.id, { name: b.name, direction: b.direction, step: b.step, category: b.category }]),
				),
				groups: groups.get(rules as unknown as ReadApi).groups,
			}),
		});

		/* ----- approving, rejecting, ending ------------------------------------------------------------ */

		ctx.commands.add<{ hero: string; season: number; version: number }>({
			type: 'opaque-research.approve',
			description:
				'Approve a hero\'s research application (paid now by the capital, no refunds). Payload: { "hero", "season", "version" } as the application says.',
			parse: shape({ hero: fields.id(), season: fields.int(0, 1e9), version: fields.int(0, 1e9) }),
			async execute(api, { hero: heroId, season, version }) {
				await syncEnds(api, api.playerId);
				const unlocked = await unlockedOf(api, api.playerId);
				if (!unlocked) throw fail('no_temple', 'Build the place that approves research first');
				const hero = await heroes.requireOwned(api, api.playerId, heroId);
				const app = await applicationOf(api, hero, unlocked);
				if (!app) throw fail('no_application', 'This hero has no application now');
				if (app.season !== season || app.version !== version) throw fail('stale', 'The application has been rewritten: look again', 409);
				const projects = await projectsOf(api, api.playerId);
				const max = await capitalStat(api, api.playerId, 'opaque-research.concurrent');
				if (projects.length >= max) throw fail('limit', text('At most {0} projects at a time', { 0: max }));
				const capital = await settlements.capital(api, api.playerId);
				if (!capital) throw fail('no_capital', 'Found your capital first');
				// Paid in full: no research, item or hero lowers it.
				await resources.spend(api, settlements.entity(capital.id), app.cost);
				await shop.spend(api, api.playerId, app.yuanbao);
				const random = seededRandom(`opaque:approve:${app.seed}`);
				const range = pointRange(app.tier, (await scores(api, hero)).points, tune(api));
				const o = offsetRule.get(api);
				const project: ProjectRow = {
					id: crypto.randomUUID(),
					player_id: api.playerId,
					hero_id: hero.id,
					tier: app.tier,
					target: app.target,
					offset: offsetDraw(random, o.sigma, o.max),
					points: Math.round((range[0] + (range[1] - range[0]) * random()) * 100) / 100,
					started_at: api.now,
					due_at: api.now + app.seconds * 1000,
				};
				api.write(
					api.db
						.prepare(
							'INSERT INTO opaque_research_projects (id, player_id, hero_id, tier, target, offset, points, started_at, due_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
						)
						.bind(
							project.id,
							project.player_id,
							project.hero_id,
							project.tier,
							project.target,
							project.offset,
							project.points,
							project.started_at,
							project.due_at,
						),
				);
				projects.push(project);
				const records = await heroRowsOf(api, api.playerId);
				const rec = records.get(hero.id) ?? { hero_id: hero.id, max_tier: 0, hosted: 0, rejected: null };
				rec.max_tier = Math.max(rec.max_tier, app.tier);
				records.set(hero.id, rec);
				saveHero(api, api.playerId, rec);
				// Other heroes' applications see this project now (they steer clear of it).
				saveValues(api, api.playerId, await valuesOf(api, api.playerId));
				timeline.schedule(api, settlements.entity(capital.id), project.due_at, 'opaque-research.done', {
					player: api.playerId,
					project: project.id,
				});
			},
		});
		ctx.commands.add<{ hero: string; season: number }>({
			type: 'opaque-research.reject',
			description: 'Turn a hero\'s application down for this season. Payload: { "hero", "season" }',
			parse: shape({ hero: fields.id(), season: fields.int(0, 1e9) }),
			async execute(api, { hero: heroId, season }) {
				const unlocked = await unlockedOf(api, api.playerId);
				const hero = await heroes.requireOwned(api, api.playerId, heroId);
				const app = await applicationOf(api, hero, unlocked);
				if (!app || app.season !== season) throw fail('no_application', 'This hero has no application now');
				const records = await heroRowsOf(api, api.playerId);
				const rec = records.get(hero.id) ?? { hero_id: hero.id, max_tier: 0, hosted: 0, rejected: null };
				rec.rejected = `${app.tier}:${season}`;
				records.set(hero.id, rec);
				saveHero(api, api.playerId, rec);
			},
		});
		// On the capital (where the project was approved): it ends whenever the capital is next used, like research.
		timeline.on<{ player: string; project: string }>('opaque-research.done', async (api, event) => {
			const playerId = event.payload.player;
			const projects = await projectsOf(api, playerId);
			const p = projects.find((x) => x.id === event.payload.project);
			if (!p) return;
			const hero = await heroes.get(api, p.hero_id);
			// Bonuses change: bank every settlement's production under the old ones first.
			for (const s of await settlements.mine(api, playerId)) await resources.settle(api, settlements.entity(s.id));
			const values = await valuesOf(api, playerId);
			const t = tune(api);
			const centre = wrapDim(p.target + p.offset);
			const share = sprintShare(values.dims, centre, hero && proposers ? (await scores(api, hero)).sprint : 0, t);
			values.dims = allocate(values.dims, centre, p.points, share, t.sprint.window);
			values.steps = groupSteps(values.dims, groups.get(api).count, t.thresholds);
			saveValues(api, playerId, values);
			api.write(api.db.prepare('DELETE FROM opaque_research_projects WHERE id = ?').bind(p.id));
			projects.splice(projects.indexOf(p), 1);
			const records = await heroRowsOf(api, playerId);
			const rec = records.get(p.hero_id) ?? { hero_id: p.hero_id, max_tier: p.tier, hosted: 0, rejected: null };
			rec.hosted += 1;
			saveHero(api, playerId, rec);
			if (hero) await heroes.grantExp(api, hero.id, exp.get(api)[String(p.tier)] ?? 0);
		});
		// A hero hosting a project stays on its post (its bonuses too) until the project ends.
		heroes.addDutyLock(
			async (api, hero) =>
				(await projectsOf(api, hero.playerId)).some((p) => p.hero_id === hero.id) ? text('Hosting a research project until it ends') : null,
			// A host is on the proposers' duty and stays there (this lock): an idle hero hosts nothing.
			(hero) => (hero.duty === 'idle' ? false : null),
		);

		ctx.services.provide('opaqueResearch', {
			defineBonus(def) {
				if (bonuses.has(def.id)) throw new PluginError(`Opaque research bonus "${def.id}" defined twice`);
				const named = { ...def, name: ctx.services.get('i18n').own(def.name) };
				bonuses.set(def.id, named);
				def.hook((api, playerId) => percentOf(api, playerId, def.id));
			},
			setProposers: (p) => void (proposers = p),
			setDefaultGroups: (g) => void (defaultGroups = g),
			setCosts: (c) => void (costsOf = c),
			setTexts: (t) => void (texts = t),
		});
	},
});
