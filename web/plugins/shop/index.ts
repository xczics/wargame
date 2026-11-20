// The shop: its page's cards worked out here over the static offers from the player's wallet (`shop.wallet`); where
// they show is the server plugin's layout (generic widgets).
import type { CardsData } from '../../../src/shared/ui';
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import { views } from './views';

export default defineClientPlugin({
	id: 'shop',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		for (const p of formParts) game.clientPart(p);
		// Bought: what the offer gives is in the inventory held here at once, for every page that shows it (user
		// 2026-11-20: bought in the shop, the items on a building page stayed as they were).
		game.afterCommand('shop.buy', (_type, payload) => {
			const { offer, quantity = 1 } = payload as { offer: string; quantity?: number };
			const card = game.static<CardsData>('shop.offers')?.cards.find((c) => c.id === offer);
			const item = card?.ref?.item;
			if (!item) return;
			const n = (card.count ?? 1) * quantity;
			game.patchView<Record<string, number>>('items.owned', (owned) => ({ ...owned, [item]: (owned[item] ?? 0) + n }));
		});
	},
});
