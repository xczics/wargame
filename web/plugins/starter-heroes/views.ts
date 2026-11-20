// The starter-heroes plugin's views assembled in the browser (src/shared/client-views.ts).
import type { HeroCardPart, HeroInfo, HeroPost } from '../../../src/shared/api';
import { defineClientPart, defineClientView, type ClientViewGet } from '../../../src/shared/client-views';
import { heroAttributes } from '../../../src/shared/heroes';
import { type HeroEffectsStatic, roleEffects, roleFlats } from '../../../src/shared/starter-heroes';
import { roleLines } from './card';
import { livePosts, postRows } from './posts';

// The posts as the heroes held here are now: who is on duty (`heroes.list`), the defence order (`heroes.defense`), the
// gear on them ("heroes.attributes"), all kept current by the commands, so a hero put on a post on the Heroes page is
// here at once.
const NEEDS = ['starter-heroes.posts', 'heroes.list', 'heroes.defense'];
const POINTS = ['heroes.attributes'];
const posts = (get: ClientViewGet) => {
	const defense = get.data<{ settlement: string; order: string[] | null } | null>('heroes.defense');
	const duties = new Map((get.meta('heroes')?.duties ?? []).map((d) => [d.id, d.inTown]));
	return livePosts(get.data<HeroPost[] | null>('starter-heroes.posts'), {
		settlement: defense?.settlement ?? get.params.settlement,
		heroes: get.data<Omit<HeroInfo, 'bonus'>[]>('heroes.list'),
		order: defense ? defense.order : undefined,
		effects: get.static<HeroEffectsStatic>('starter-heroes.effects'),
		inTown: (duty) => duties.get(duty),
		attrs: (h) => heroAttributes(h, get),
	});
};

export const views = [
	defineClientView({
		id: 'starter-heroes.posts-city',
		needs: NEEDS,
		points: POINTS,
		compute: (get) => postRows(posts(get), false),
	}),
	defineClientView({
		id: 'starter-heroes.posts-entry',
		needs: NEEDS,
		points: POINTS,
		compute: (get) => postRows(posts(get), true),
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
			return effects
				? roleLines(roleEffects(effects.rows, effects.rules, hero), effects.flat ? roleFlats(effects.flat, effects.rules, hero) : {})
				: [];
		},
	}),
];
