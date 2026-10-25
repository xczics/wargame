// The starter-heroes plugin's views assembled in the browser (src/shared/client-views.ts).
import type { HeroCardPart, HeroPost } from '../../../src/shared/api';
import { defineClientPart, defineClientView } from '../../../src/shared/client-views';
import { type HeroEffectsStatic, roleEffects } from '../../../src/shared/starter-heroes';
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
	// On hero cards: what the hero would give in each role, from its attributes (every bonus) and the rules baked into the
	// static `starter-heroes.effects` (the server sums them with the same `roleEffects` code).
	defineClientPart<HeroCardPart>({
		point: 'heroes.card',
		id: 'starter-heroes',
		part: (_data, hero, get) => {
			const effects = get.static<HeroEffectsStatic>('starter-heroes.effects');
			return effects ? roleLines(roleEffects(effects.rows, effects.rules, hero)) : [];
		},
	}),
];
