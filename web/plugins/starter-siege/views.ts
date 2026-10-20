// The starter-siege plugin's views assembled in the browser (src/shared/client-views.ts).
import type { SiegeWall } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { wallQueue, wallRows } from './wall';

export const views = [
	defineClientView({
		id: 'starter-siege.queue',
		needs: ['starter-siege.wall'],
		compute: (get) => wallQueue(get.data<SiegeWall | null>('starter-siege.wall'), get.meta('resources') ?? []),
	}),
	defineClientView({
		id: 'starter-siege.rows',
		needs: ['starter-siege.wall'],
		compute: (get) => wallRows(get.data<SiegeWall | null>('starter-siege.wall'), get.meta('resources') ?? []),
	}),
];
