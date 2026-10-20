// The starter-heroes plugin's views assembled in the browser (src/shared/client-views.ts).
import type { HeroCardPart, HeroPost, HeroRoleEffects } from '../../../src/shared/api';
import { defineClientPart, defineClientView } from '../../../src/shared/client-views';
import { roleLines } from './card';
import { postRows } from './posts';

export const views = [
	defineClientView({
		id: 'starter-heroes.posts-city',
		needs: ['starter-heroes.posts'],
		compute: (get) => postRows(get.data<HeroPost[] | null>('starter-heroes.posts'), false),
	}),
	defineClientView({
		id: 'starter-heroes.posts-entry',
		needs: ['starter-heroes.posts'],
		compute: (get) => postRows(get.data<HeroPost[] | null>('starter-heroes.posts'), true),
	}),
];

export const parts = [
	// On hero cards: what the hero would give in each role, from what the starter-heroes plugin attaches to each hero.
	defineClientPart<HeroCardPart>({ point: 'heroes.card', id: 'starter-heroes', part: (data) => roleLines(data as HeroRoleEffects) }),
];
