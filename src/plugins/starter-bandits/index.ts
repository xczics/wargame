/**
 * Default bandits (docs/design/gameplay.md §12.2-12.4): six kinds by terrain, ten levels, named
 * leaders from level 3 (./data). The capital draws them more than other settlements; a new resource
 * fortress is left alone for a day. A beaten band may leave a cache of resources behind.
 */
import { csvRules, definePlugin, GameError, numberFields } from '../../kernel';
import kindsCsv from './data/kinds.csv?raw';
import levelsCsv from './data/levels.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

const RULES = csvRules(rulesCsv) as {
	capitalWeight: number;
	freshHours: Record<string, number>;
	resourceDrop: { weight: number; perLevel: number };
};

export default definePlugin({
	id: 'starter-bandits',
	version: '0.1.0',
	description: 'Six kinds of bandits by terrain, ten levels; the capital draws them most',
	dependsOn: ['bandits', 'resources', 'settlements', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv);
		const bandits = ctx.services.get('bandits');
		const resources = ctx.services.get('resources');
		const settlements = ctx.services.get('settlements');
		const rules = ctx.config.define('rules', {
			description:
				'capitalWeight: how much likelier the capital is a target; freshHours: by settlement kind, how long a new one is no target; resourceDrop: weight and size (per band level) of a resource cache from a beaten band.',
			default: () => RULES,
			parse(raw) {
				const r = (raw ?? {}) as Record<string, unknown>;
				for (const k of Object.keys(r)) if (!(k in RULES)) throw new GameError('bad_config', `Unknown field "${k}"`);
				return {
					capitalWeight: numberFields(() => ({ v: RULES.capitalWeight }), 0, 1000)({ v: r.capitalWeight ?? RULES.capitalWeight }).v,
					freshHours: numberFields(() => RULES.freshHours, 0, 24 * 365)(r.freshHours ?? {}),
					resourceDrop: numberFields(() => RULES.resourceDrop, 0, 1e9)(r.resourceDrop ?? {}),
				};
			},
		});

		bandits.defineKindsFromCsv(kindsCsv);
		bandits.defineLevelsFromCsv(levelsCsv);
		bandits.setTargetWeight(async (api, s, base, at) => {
			const r = rules.get(api);
			const fresh = r.freshHours[s.kind];
			if (fresh && at < s.createdAt + fresh * 3_600_000) return 0;
			return s.kind === 'capital' ? base * r.capitalWeight : base;
		});
		bandits.addDrop({
			id: 'starter-bandits.resources',
			weight: RULES.resourceDrop.weight,
			async give(api, c) {
				const list = resources.list();
				const res = list[Math.floor(c.random() * list.length)];
				const amount = Math.round(rules.get(api).resourceDrop.perLevel * c.level);
				if (!res || amount <= 0) return [];
				await resources.add(api, settlements.entity(c.settlementId), res.id, amount);
				return [{ kind: 'resource', name: res.name, ...(res.icon ? { icon: res.icon } : {}), count: amount }];
			},
		});
	},
});
