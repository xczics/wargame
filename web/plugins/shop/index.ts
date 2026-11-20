// The shop: its page's cards worked out here over the static offers from the player's wallet (`shop.wallet`); where
// they show is the server plugin's layout (generic widgets).
import type { ShopWallet } from '../../../src/shared/api';
import type { CardsData } from '../../../src/shared/ui';
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import { bought, granted, priceOf } from './patches';
import { views } from './views';

export default defineClientPlugin({
	id: 'shop',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		for (const p of formParts) game.clientPart(p);
		// Bought: what the offer gives is in the inventory held here at once, for every page that shows it (user
		// 2026-11-20: bought in the shop, the items on a building page stayed as they were).
		// Paid too: the balance on every page that shows it (the trade routes too), and today's purchases.
		game.afterCommand('shop.buy', (_type, payload) => {
			const { offer, quantity = 1 } = payload as { offer: string; quantity?: number };
			const offers = game.static<CardsData>('shop.offers');
			const card = offers?.cards.find((c) => c.id === offer);
			const price = priceOf(offers, offer);
			if (price === undefined) game.markStale('shop.wallet');
			else game.patchView<ShopWallet>('shop.wallet', (w) => bought(w, offer, Number(quantity), price));
			const item = card?.ref?.item;
			if (!item) return;
			const n = (card.count ?? 1) * Number(quantity);
			game.patchView<Record<string, number>>('items.owned', (owned) => ({ ...owned, [item]: (owned[item] ?? 0) + n }));
		});
		// The GM's coupons for the player.
		game.afterCommand('shop.grant', (_type, payload) => {
			const { amount } = payload as { amount: number };
			game.patchView<ShopWallet>('shop.wallet', (w) => granted(w, Number(amount)));
		});
	},
});
