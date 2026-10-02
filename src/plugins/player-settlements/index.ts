/**
 * Default content: the four kinds of player settlement.
 *
 *   capital            inner city (non-resource buildings) + outer cities (resource buildings); one per player
 *   city               same layout, limited number per player
 *   fortress-resource  one tile: storage + resource buildings; no troops
 *   fortress-military  one tile: storage only; can garrison troops
 *
 * Slot counts, limits and founding costs are in ./data (CSV) and GM-tunable. NPC kinds (troop fortresses,
 * food outposts, ...) belong in their own plugins, registered the same way with `npc: true`.
 */
import { csvNumber, csvRows, csvRules, definePlugin, gameErrors, numberFields, numberInRange, numberRecord } from '../../kernel';
import type { Cost } from '../resources';
import costsCsv from './data/costs.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { uiTexts } from '../../shared/i18n';

const fail = gameErrors('player-settlements');
const text = uiTexts('player-settlements');

/** Categories an inner city accepts: everything except resource buildings. */
const INNER = ['civic', 'military', 'storage'];
const RULES = csvRules(rulesCsv);
/** Founding costs by kind ("outer": the first extra outer city). */
const COSTS: Record<string, Cost> = Object.fromEntries(
	csvRows(costsCsv).map((row) => [
		row.kind,
		Object.fromEntries(
			Object.entries(row)
				.filter(([k, v]) => k !== 'kind' && v !== '')
				.map(([k]) => [k, csvNumber(row, k)]),
		),
	]),
);

export default definePlugin({
	id: 'player-settlements',
	version: '0.1.0',
	description: 'Capital, city, resource fortress and military fortress',
	dependsOn: ['settlements', 'resources', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const cost = numberRecord(() => resources.list().map((r) => r.id), 0, 1e12);

		const innerSlots = ctx.config.define('innerSlots', {
			description: 'Building slots of an inner city (capital and cities).',
			default: () => RULES.innerSlots as number,
			parse: numberInRange(1, 100),
		});
		const outerSlots = ctx.config.define<[number, number] | [number, number, number]>('outerSlots', {
			description: 'Building slots of a new outer city: [min, most likely, max] (average of the three), or [min, max] evenly.',
			default: () => [RULES.outerSlots.min, RULES.outerSlots.mode, RULES.outerSlots.max],
			parse(raw) {
				if (!Array.isArray(raw) || (raw.length !== 2 && raw.length !== 3))
					throw fail('bad_config', 'Expected [min, most likely, max] or [min, max]');
				const n = raw.map((v) => Math.floor(numberInRange(1, 100)(v)));
				if (n.some((v, i) => i && v < n[i - 1])) throw fail('bad_config', 'The numbers must not decrease');
				return n as [number, number] | [number, number, number];
			},
		});
		const fortressSlots = ctx.config.define('fortressSlots', {
			description: 'Building slots of fortresses by kind.',
			default: () => RULES.fortressSlots as Record<string, number>,
			parse: numberFields(() => RULES.fortressSlots, 1, 100),
		});
		const limits = ctx.config.define('limits', {
			description: 'Settlements of each kind per player, before bonuses.',
			default: () => RULES.limits as Record<string, number>,
			parse: numberFields(() => RULES.limits, 0, 1000),
		});
		const limitMax = ctx.config.define('limitMax', {
			description: 'Hard limit of settlements of each kind per player, whatever the bonuses (techs, prestige, items).',
			default: () => RULES.limitMax as Record<string, number>,
			parse: numberFields(() => RULES.limitMax, 0, 1000),
		});
		/** Costs by kind, merged per kind over the data file. */
		const costRule = (name: string, description: string, kinds: string[]) =>
			ctx.config.define<Record<string, Cost>>(name, {
				description,
				default: () => Object.fromEntries(kinds.map((k) => [k, COSTS[k] ?? {}])),
				parse(raw) {
					const r = (raw ?? {}) as Record<string, unknown>;
					const out: Record<string, Cost> = Object.fromEntries(kinds.map((k) => [k, COSTS[k] ?? {}]));
					for (const k of Object.keys(r)) {
						if (!(k in out)) throw fail('bad_config', text('Unknown settlement kind "{0}"', { 0: k }));
						out[k] = cost(r[k]);
					}
					return out;
				},
			});
		const foundCosts = costRule('foundCosts', 'Resources paid by the founding settlement, per kind. Omitted kinds keep the default.', [
			'city',
			'fortress-resource',
			'fortress-military',
		]);
		const outerCost = ctx.config.define('outerCost', {
			description: 'Cost of the first extra outer city; the n-th extra one costs n times this.',
			default: () => COSTS.outer ?? {},
			parse: (raw) => cost(raw),
		});

		const inner = { type: 'inner', accepts: [...INNER], slots: (api: Parameters<typeof innerSlots.get>[0]) => innerSlots.get(api) };
		const outer = {
			type: 'outer',
			accepts: ['resource'],
			slots: (api: Parameters<typeof outerSlots.get>[0]) => outerSlots.get(api),
			initial: 1,
			cost: (api: Parameters<typeof outerCost.get>[0]) => outerCost.get(api),
		};

		settlements.defineKind({
			id: 'capital',
			name: 'Capital',
			icon: '🏰',
			garrison: true,
			layout: 'ring',
			centre: inner,
			outer,
			limit: () => 1,
		});
		settlements.defineKind({
			id: 'city',
			icon: '🏘️',
			name: 'City',
			garrison: true,
			layout: 'ring',
			centre: { ...inner, accepts: [...INNER] },
			outer: { ...outer, accepts: ['resource'] },
			limit: (api) => limits.get(api).city,
			limitMax: (api) => limitMax.get(api).city,
			foundCost: (api) => foundCosts.get(api).city,
		});
		settlements.defineKind({
			id: 'fortress-resource',
			icon: '⛏️',
			name: 'Resource fortress',
			garrison: false,
			layout: 'single',
			centre: { type: 'core', accepts: ['storage', 'resource'], slots: (api) => fortressSlots.get(api)['fortress-resource'] },
			limit: (api) => limits.get(api)['fortress-resource'],
			foundCost: (api) => foundCosts.get(api)['fortress-resource'],
		});
		settlements.defineKind({
			id: 'fortress-military',
			icon: '🛡️',
			name: 'Military fortress',
			garrison: true,
			layout: 'single',
			centre: { type: 'core', accepts: ['storage'], slots: (api) => fortressSlots.get(api)['fortress-military'] },
			limit: (api) => limits.get(api)['fortress-military'],
			foundCost: (api) => foundCosts.get(api)['fortress-military'],
		});
	},
});
