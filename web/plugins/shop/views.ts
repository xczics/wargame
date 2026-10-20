// The shop plugin's views assembled in the browser (src/shared/client-views.ts).
import type { ShopWallet } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { shopCards } from './cards';

export const views = [
	defineClientView({ id: 'shop.cards', needs: ['shop.wallet'], compute: (get) => shopCards(get.data<ShopWallet>('shop.wallet')) }),
];
