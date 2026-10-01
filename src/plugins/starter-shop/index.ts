/**
 * Default shop offers (docs/design/gameplay.md §11.2), from ./data/offers.csv. The items
 * themselves (and what they do) belong to the items plugins.
 */
import { csvNumber, csvRows, definePlugin } from '../../kernel';
import offersCsv from './data/offers.csv?raw';

export default definePlugin({
	id: 'starter-shop',
	version: '0.1.0',
	description: 'The default offers of the coupon shop',
	dependsOn: ['shop', 'starter-items'],
	setup(ctx) {
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
	},
});
