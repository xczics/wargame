// The items plugin's views assembled in the browser (src/shared/client-views.ts).
import type { ItemCatalog, ItemsExtra } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import type { CardsData } from '../../../src/shared/ui';
import { itemCards, itemShortcuts } from './cards';

export const views = [
	defineClientView({
		id: 'items.cards',
		needs: ['items.owned', 'items.extra'],
		compute: (get) =>
			itemCards(
				get.data<Record<string, number>>('items.owned'),
				get.data<ItemsExtra>('items.extra'),
				get.static<ItemCatalog>('items.catalog'),
			),
	}),
	defineClientView({
		id: 'items.shortcuts',
		needs: ['items.owned'],
		compute: (get) => itemShortcuts(get.data<Record<string, number>>('items.owned'), get.static<CardsData>('items.shortcut-cards')),
	}),
];
