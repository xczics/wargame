// What the shop's commands did, in the wallet held in the browser (`game.patchView`). Pure: the tests run it.
import type { ShopWallet } from '../../../src/shared/api';
import type { CardsData } from '../../../src/shared/ui';

/** The price of an offer as its static card has it (what the buy button needs in yuanbao). */
export const priceOf = (offers: CardsData | undefined, offer: string) =>
	offers?.cards.find((c) => c.id === offer)?.needs?.find((n) => n.counter === 'yuanbao')?.amount;

/** Bought `quantity` of an offer at `price` each: paid, and counted towards today's limit. */
export const bought = (w: ShopWallet, offer: string, quantity: number, price: number): ShopWallet => ({
	balance: Math.max(0, w.balance - price * quantity),
	today: { ...w.today, [offer]: (w.today[offer] ?? 0) + quantity },
});

/** Coupons granted (negative: taken, never below zero), whole as the server keeps them. */
export const granted = (w: ShopWallet, amount: number): ShopWallet => ({ ...w, balance: Math.max(0, w.balance + Math.trunc(amount)) });
