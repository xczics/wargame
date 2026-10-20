// The shop page's cards (`shop.cards`), assembled in the browser (AGENTS.md: the server sends data only) over the static
// offers (`shop.offers`) from the player's wallet (`shop.wallet`): the balance and what was bought today, as the
// counters the static cards' prices and daily limits go by. Pure: the tests run it. The shop plugin's own words.
import type { ShopWallet } from '../../../src/shared/api';
import { whole } from '../../../src/shared/format';
import { uiTexts } from '../../../src/shared/i18n';
import type { CardsData } from '../../../src/shared/ui';

const text = uiTexts('shop');

export function shopCards(wallet: ShopWallet | undefined): CardsData | undefined {
	if (!wallet) return undefined;
	return {
		base: 'shop.offers',
		summary: [text('💰 {n} yuanbao', { n: whole(wallet.balance) })],
		counters: { yuanbao: wallet.balance, ...Object.fromEntries(Object.entries(wallet.today).map(([id, n]) => [`today:${id}`, n])) },
		cards: [],
	};
}
