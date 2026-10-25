// The heroes plugin's views assembled in the browser (src/shared/client-views.ts).
import type { HeroCardPart, HeroesState, HeroInfo, HeroOffers } from '../../../src/shared/api';
import { heroAttributes } from '../../../src/shared/heroes';
import { defineClientView } from '../../../src/shared/client-views';
import { candidateCards, defenseRows, heroCards } from './cards';

export const views = [
	// The player's heroes with what the client parts at "heroes.attributes" add (the assistant judges by them).
	defineClientView({
		id: 'heroes.roster',
		needs: ['heroes.list'],
		points: ['heroes.attributes'],
		compute: (get) =>
			get.data<Omit<HeroInfo, 'bonus'>[]>('heroes.list')?.map((h): HeroInfo => {
				const all = heroAttributes(h, get);
				const bonus = Object.fromEntries(
					Object.entries(all).flatMap(([a, n]) => (n !== (h.attrs[a] ?? 0) ? [[a, n - (h.attrs[a] ?? 0)]] : [])),
				);
				return { ...h, bonus };
			}),
	}),
	defineClientView({
		id: 'heroes.cards',
		needs: ['heroes.state'],
		points: ['heroes.card', 'heroes.attributes'],
		compute: (get) =>
			heroCards(get.data<HeroesState | null>('heroes.state'), get.meta('heroes'), get.parts<HeroCardPart>('heroes.card'), get),
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
