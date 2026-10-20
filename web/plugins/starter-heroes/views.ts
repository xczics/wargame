// The starter-heroes plugin's views assembled in the browser (src/shared/client-views.ts).
import type { HeroPost } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
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
