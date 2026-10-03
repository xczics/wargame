/**
 * Default shop offers (docs/design/gameplay.md §11.2), from ./data/offers.csv. The items
 * themselves (and what they do) belong to the items plugins. Realms drop a little yuanbao too.
 */
import { csvNumber, csvRows, csvRules, definePlugin, numberFields } from '../../kernel';
import offersCsv from './data/offers.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { uiTexts } from '../../shared/i18n';

const text = uiTexts('starter-shop');
const RULES = csvRules(rulesCsv) as { realmDrop: { weight: number; perRealm: number } };

export default definePlugin({
	id: 'starter-shop',
	version: '0.1.0',
	description: 'The default offers of the coupon shop',
	dependsOn: ['shop', 'realms', 'starter-items', 'starter-equipment', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const shop = ctx.services.get('shop');
		for (const r of csvRows(offersCsv))
			shop.defineOffer({
				id: r.id,
				item: r.item,
				count: csvNumber(r, 'count'),
				price: csvNumber(r, 'price'),
				category: r.category,
				dailyLimit: csvNumber(r, 'dailyLimit', 0),
			});

		const realmDrop = ctx.config.define('realmDrop', {
			description: 'Yuanbao from realms: weight in each reward pool; perRealm x the realm order is how many.',
			default: () => RULES.realmDrop,
			parse: numberFields(() => RULES.realmDrop, 0, 1e6),
		});
		ctx.services.get('realms').addDrop({
			id: 'starter-shop.yuanbao',
			weight: (_realm, _task, api) => realmDrop.get(api).weight,
			preview: { kind: 'yuanbao', name: text('Yuanbao').text, icon: '💰' },
			async give(api, c) {
				const n = Math.round(realmDrop.get(api).perRealm * c.realm.order);
				await shop.grant(api, c.playerId, n);
				return [{ kind: 'yuanbao', name: text('Yuanbao').text, icon: '💰', count: n }];
			},
		});
	},
});
