// The heroes plugin's views assembled in the browser (src/shared/client-views.ts).
import type { HeroesState, HeroOffers } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { candidateCards, defenseRows, heroCards } from './cards';

export const views = [
	defineClientView({
		id: 'heroes.cards',
		needs: ['heroes.state'],
		compute: (get) => heroCards(get.data<HeroesState | null>('heroes.state')),
	}),
	defineClientView({
		id: 'heroes.defense-rows',
		needs: ['heroes.state'],
		compute: (get) => defenseRows(get.data<HeroesState | null>('heroes.state')),
	}),
	defineClientView({
		id: 'heroes.candidate-cards',
		needs: ['heroes.offers'],
		compute: (get) => candidateCards(get.data<HeroOffers | null>('heroes.offers')),
	}),
];
