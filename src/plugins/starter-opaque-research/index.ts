/**
 * Default opaque research content (docs/design/gameplay.md §14): the Shuangqing Temple in the capital (approves projects;
 * each level one more at a time, tiers unlocked at set levels), heroes posted at an institute write the applications,
 * the bonuses (each resource's production, troop upkeep, construction and training time), what each tier costs, and
 * the sentences applications and reviews are made of (data/texts.csv; dimensions named after hexagrams).
 */
import { csvNumber, csvRows, csvRules, definePlugin, fields, numberFields, PluginError, type ReadApi, shape } from '../../kernel';
import type { OpaqueGroup } from '../../shared/api';
import type { UiText } from '../../shared/ui';
import type { BattleStat } from '../battle';
import { keyText, uiTexts } from '../../shared/i18n';
import { reduction } from '../../shared/stats';
import buildingsCsv from './data/buildings.csv?raw';
import levelsCsv from './data/levels.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import bonusesCsv from './data/bonuses.csv?raw';
import groupsCsv from './data/groups.csv?raw';
import textsCsv from './data/texts.csv?raw';
import hexagramsCsv from './data/hexagrams.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

const text = uiTexts('starter-opaque-research');
const RULES = csvRules(rulesCsv) as {
	unlocks: Record<string, number>;
	requires: Record<string, number>;
	costs: Record<string, Record<string, number>>;
	attributes: { points: Record<string, number>; sprint: Record<string, number> };
};
const TEMPLE = 'shuangqing-temple';
const LEVEL_STAT = 'starter-opaque-research.level';
const TIERS = ['1', '2', '3', '4'];
const POSITIONS = [
	['I', '初'],
	['II', '二'],
	['III', '三'],
	['IV', '四'],
];
const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;
const SENTENCES = csvRows(textsCsv);
// Sentences and code names as this plugin's keys ("s:bg1", "code:0" ...), built once from their own files.
const HEXAGRAMS = csvRows(hexagramsCsv);
const GENERATED = [
	'key,en,zh-CN',
	...SENTENCES.map((r) => [`s:${r.id}`, r.en, r['zh-CN']].map(quote).join(',')),
	...HEXAGRAMS.flatMap((h, i) =>
		POSITIONS.map(([en, zh], p) => [`code:${i * 4 + p}`, `${h.en} ${en}`, `${h['zh-CN']}·${zh}`].map(quote).join(',')),
	),
].join('\n');
const tags = (when: string) =>
	Object.fromEntries(
		when
			.split(';')
			.map((x) => x.trim())
			.filter(Boolean)
			.map((x) => x.split(':').map((y) => y.trim()) as [string, string]),
	);

export default definePlugin({
	id: 'starter-opaque-research',
	version: '0.1.0',
	description: 'Opaque research content: the Shuangqing Temple, the bonuses, costs and application texts',
	dependsOn: [
		'opaque-research',
		'buildings',
		'settlements',
		'stats',
		'troops',
		'i18n',
		'starter-content',
		'starter-research',
		'starter-heroes',
		'starter-army',
		'research',
		'starter-siege',
		'battle',
		'ui',
	],
	setup(ctx) {
		const i18n = ctx.services.get('i18n');
		i18n.addCsv(i18nCsv, ctx.pluginId);
		i18n.addCsv(GENERATED, ctx.pluginId);
		const opaque = ctx.services.get('opaqueResearch');
		const buildings = ctx.services.get('buildings');
		const settlements = ctx.services.get('settlements');
		const stats = ctx.services.get('stats');
		const troops = ctx.services.get('troops');
		const source = text('Opaque research');

		/* ----- the temple ---------------------------------------------------------------------- */

		stats.define({ id: LEVEL_STAT, description: text('Temple level'), base: () => 0, integer: true, min: 0, hidden: true });
		buildings.defineFromCsv(buildingsCsv, levelsCsv);
		const unlocks = ctx.config.define('unlocks', {
			description: 'Shuangqing Temple level from which each tier of project may be approved.',
			default: () => RULES.unlocks,
			parse: numberFields(() => RULES.unlocks, 1, 1000),
		});
		const requires = ctx.config.define('requires', {
			description: "Levels the capital's institute and palace need before the Shuangqing Temple can be built.",
			default: () => RULES.requires,
			parse: numberFields(() => RULES.requires, 0, 1000),
		});
		// The highest tier the temple's level allows (its level counted by a stat of its own: readable anywhere).
		stats.contribute('opaque-research.tier', async (api, target) => {
			const level = await stats.get(api, LEVEL_STAT, target);
			if (!level) return null;
			const u = unlocks.get(api);
			return { flat: TIERS.filter((t) => level >= u[t]).length };
		});
		// The card says what its hidden stats do: projects at a time, the highest tier it approves (0: none yet); worded by
		// the client plugin (web/plugins/opaque-research/effects.ts).
		buildings.addEffects(TEMPLE, async (api, _settlement, level) => ({
			projects: level,
			tier: Number(TIERS.filter((t) => level >= unlocks.get(api)[t]).at(-1) ?? 0),
		}));
		const needs = { institute: 'institute', palace: 'palace' } as const;
		buildings.addGate(async (api, req) => {
			if (req.building.id !== TEMPLE || req.fromLevel > 0) return null;
			const r = requires.get(api);
			for (const [field, building] of Object.entries(needs)) {
				if ((await buildings.level(api, req.settlement.id, building)) < r[field])
					return text('Requires {0} Lv {1}', { 0: keyText(buildings.get(building).name), 1: r[field] });
			}
			return null;
		});
		buildings.addCatalogNeeds((rules, building) =>
			building.id !== TEMPLE
				? []
				: Object.entries(needs).map(([field, b]) => ({
						from: 1,
						need: {
							counter: `${ctx.pluginId}:${b}`,
							amount: requires.get(rules)[field],
							short: text('Requires {0} Lv {1}', { 0: keyText(buildings.get(b).name), 1: requires.get(rules)[field] }),
						},
					})),
		);
		buildings.addCounters(async (api, settlement) => {
			if (settlement.kind !== 'capital') return {};
			const out: Record<string, number> = {};
			for (const b of Object.values(needs)) out[`${ctx.pluginId}:${b}`] = await buildings.level(api, settlement.id, b);
			return out;
		});

		/* ----- who applies, what it costs ---------------------------------------------------------- */

		// Several attributes count for each (equipment included), learning most for points, strategy most for the sprint.
		const weights = ctx.config.define('attributes', {
			description:
				"How the heroes' attributes count (weights, by attribute; summing to 1 keeps an attribute's scale): points (how much a project brings) and sprint (how much goes to its centre).",
			default: () => RULES.attributes,
			parse(raw) {
				const r = shape({ points: fields.optional(fields.raw()), sprint: fields.optional(fields.raw()) })(raw);
				return {
					points: numberFields(() => RULES.attributes.points, 0, 10)(r.points ?? {}),
					sprint: numberFields(() => RULES.attributes.sprint, 0, 10)(r.sprint ?? {}),
				};
			},
		});
		opaque.setProposers({ duty: 'scholar', points: (api) => weights.get(api).points, sprint: (api) => weights.get(api).sprint });
		const costs = ctx.config.define('costs', {
			description:
				'What a project of each tier costs (paid in full by the capital, no discounts), how long it runs (seconds) and the yuanbao it takes.',
			default: () => RULES.costs,
			// Partial: a tier left out, or a field of one, keeps the default.
			parse(raw) {
				const r = shape({ ...Object.fromEntries(TIERS.map((t) => [t, fields.optional(fields.raw())])) })(raw) as Record<string, unknown>;
				return Object.fromEntries(TIERS.map((t) => [t, numberFields(() => RULES.costs[t], 0, 1e12)(r[t] ?? {})]));
			},
		});
		opaque.setCosts((api, tier) => {
			const { seconds, yuanbao, ...cost } = costs.get(api)[String(tier)];
			return { cost, seconds, yuanbao };
		});

		/* ----- bonuses ------------------------------------------------------------------------- */

		const ownerOf = async (api: ReadApi, settlementId: string) => (await settlements.get(api, settlementId))?.ownerId ?? null;
		type Percent = (api: ReadApi, playerId: string) => Promise<number>;
		const percentFor = async (api: ReadApi, percent: Percent, settlementId: string) => {
			const owner = await ownerOf(api, settlementId);
			return owner ? percent(api, owner) : 0;
		};
		type Unit = { tier?: number; family?: string };
		/** Which units / resources a variant covers ("t3", "food", "t3-food", a family; empty: all). */
		type Which = { tier?: number; resource?: string; family?: string };
		const fits = (w: Which, unit?: Unit, resource?: string) =>
			(w.tier === undefined || unit?.tier === w.tier) &&
			(w.family === undefined || unit?.family === w.family) &&
			(w.resource === undefined || resource === w.resource);
		/** A percent on a stat of the player's settlements. */
		const onStat = (stat: string) => (percent: Percent) =>
			stats.contribute(
				stat,
				async (api, target) => {
					const id = settlements.idOf(target);
					if (!id) return null;
					const p = await percentFor(api, percent, id);
					return p ? { percent: p } : null;
				},
				source,
			);
		/** A battle modifier of the player's side, for a family or tier if given (counters: the x3 raised by it). */
		const inBattle = (stat: BattleStat, w: Which) => (percent: Percent) =>
			ctx.services.get('battle').addModifier(async (api, side) => {
				if (!side.playerId) return [];
				const p = await percent(api, side.playerId);
				return p ? [{ source, stat, percent: p, ...(w.family ? { family: w.family } : {}), ...(w.tier ? { tier: w.tier } : {}) }] : [];
			});
		// The finer troop-upkeep bonuses share one modifier: asked per unit type and resource, it only reads those that fit.
		const troopVariants: { w: Which; percent: Percent }[] = [];
		troops.addUnitUpkeepModifier(async (api, settlementId, unit, resource) => {
			let f = 1;
			for (const v of troopVariants) if (fits(v.w, unit, resource)) f *= reduction(await percentFor(api, v.percent, settlementId));
			return f;
		});
		const wiring: Record<string, (w: Which) => (percent: Percent) => void> = {
			output: (w) => onStat(w.resource ? `resources.output.${w.resource}` : 'resources.productionFactor'),
			capacity: () => onStat('resources.capacity'),
			'troop-upkeep': (w) => (percent) =>
				w.tier === undefined && w.resource === undefined && w.family === undefined
					? troops.addUpkeepModifier(async (api, settlementId) => reduction(await percentFor(api, percent, settlementId)), source)
					: void troopVariants.push({ w, percent }),
			'defense-upkeep': (w) => (percent) =>
				ctx.services
					.get('starterSiege')
					.addUpkeepModifier(async (api, settlementId, resource) =>
						fits(w, undefined, resource) ? reduction(await percentFor(api, percent, settlementId)) : 1,
					),
			'build-time': () => (percent) =>
				buildings.addTimeModifier(
					async (api, req) => (req.settlement.ownerId ? reduction(await percent(api, req.settlement.ownerId)) : 1),
					source,
				),
			'research-time': () => (percent) =>
				ctx.services.get('research').addCostModifier(async (api, req) => {
					const p = await percent(api, req.playerId);
					return p ? { timeFactor: reduction(p) } : null;
				}, source),
			'train-time': (w) => (percent) =>
				troops.addTrainingTimeModifier(
					async (api, settlement, unit) => (settlement.ownerId && fits(w, unit) ? reduction(await percent(api, settlement.ownerId)) : 1),
					source,
				),
			attack: (w) => inBattle('attack', w),
			defense: (w) => inBattle('defense', w),
			hp: (w) => inBattle('hp', w),
			counter: (w) => inBattle('counter', w),
		};
		// The breakdowns, from the content: resources, troop tiers, troop families.
		const resourceList = ctx.services.get('resources').list();
		const tiers = [...new Set(troops.list().flatMap((u) => (u.tier ? [u.tier] : [])))].sort((a, b) => a - b);
		const families = ctx.services.get('battle').families();
		const tierText = (t: number) => text('tier {0} troops', { 0: t });
		const variants = (by: string): { key: string; w: Which; label: UiText }[] => {
			switch (by) {
				case 'resource':
					return resourceList.map((r) => ({ key: r.id, w: { resource: r.id }, label: keyText(r.name) }));
				case 'tier':
					return tiers.map((t) => ({ key: `t${t}`, w: { tier: t }, label: tierText(t) }));
				case 'tier-resource':
					return tiers.flatMap((t) =>
						resourceList.map((r) => ({
							key: `t${t}-${r.id}`,
							w: { tier: t, resource: r.id },
							label: text('{0}, {1}', { 0: tierText(t), 1: keyText(r.name) }),
						})),
					);
				case 'family':
					return families.map((f) => ({ key: f.id, w: { family: f.id }, label: keyText(f.name) }));
				default:
					throw new PluginError(`bonuses.csv: unknown breakdown "${by}"`);
			}
		};
		for (const b of csvRows(bonusesCsv)) {
			const wire = wiring[b.id];
			if (!wire) throw new PluginError(`bonuses.csv: no wiring for "${b.id}"`);
			const base = { direction: b.direction as 'increase' | 'decrease', step: csvNumber(b, 'step'), category: b.category };
			opaque.defineBonus({ ...base, id: b.id, name: b.name, hook: wire({}) });
			for (const by of (b.by ?? '')
				.split(';')
				.map((x) => x.trim())
				.filter(Boolean))
				for (const v of variants(by))
					opaque.defineBonus({
						...base,
						id: `${b.id}:${v.key}`,
						name: i18n.derive(`bonus:${b.id}:${v.key}`, text(b.each, { 0: v.label })),
						hook: wire(v.w),
					});
		}
		const layout: OpaqueGroup[] = [];
		for (const r of csvRows(groupsCsv)) (layout[csvNumber(r, 'group') - 1] ??= []).push({ bonus: r.bonus, step: csvNumber(r, 'step') });
		opaque.setDefaultGroups(layout);

		/* ----- where it shows ------------------------------------------------------------------- */

		const ui = ctx.services.get('ui');
		ui.entry({
			kind: 'building',
			types: [TEMPLE],
			widget: 'opaque-research.temple',
			order: 10,
			props: { view: 'opaque-research.status', texts: 'opaque-research.texts' },
		});
		ui.block({
			page: 'research',
			column: 'left',
			widget: 'opaque-research.bonuses',
			order: 30,
			props: { view: 'opaque-research.status', texts: 'opaque-research.texts' },
		});

		/* ----- texts --------------------------------------------------------------------------- */

		opaque.setTexts({
			sentences: SENTENCES.map((r) => ({
				section: r.section,
				when: tags(r.when ?? ''),
				weight: Number(r.weight) || 1,
				text: `${ctx.pluginId}.s:${r.id}`,
			})),
			codes: Array.from({ length: HEXAGRAMS.length * 4 }, (_, i) => `${ctx.pluginId}.code:${i}`),
			reviewers: ['Reviewer A', 'Reviewer B', 'Reviewer C'].map((k) => `${ctx.pluginId}.${k}`),
		});
	},
});
