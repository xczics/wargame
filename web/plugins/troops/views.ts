// The troops plugin's views assembled in the browser (src/shared/client-views.ts).
import type { GarrisonInfo } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { trainingTimers } from './training';

export const views = [
	defineClientView({
		id: 'troops.training',
		needs: ['troops.garrison'],
		compute: (get) =>
			trainingTimers(get.data<GarrisonInfo | null>('troops.garrison'), get.meta('units') ?? [], get.meta('resources') ?? []),
	}),
];
