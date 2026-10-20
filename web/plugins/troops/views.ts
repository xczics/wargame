// The troops plugin's views assembled in the browser (src/shared/client-views.ts).
import type { GarrisonInfo, ResourceMeta, TroopsState, UnitMeta } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { garrisonRows } from './garrisons';
import { trainingTimers } from './training';

export const views = [
	defineClientView({
		id: 'troops.garrisons',
		needs: ['troops.state'],
		compute: (get) =>
			garrisonRows(get.data<TroopsState>('troops.state'), get.meta<UnitMeta[]>('units'), get.meta<ResourceMeta[]>('resources')),
	}),
	defineClientView({
		id: 'troops.training',
		needs: ['troops.garrison'],
		compute: (get) =>
			trainingTimers(get.data<GarrisonInfo | null>('troops.garrison'), get.meta('units') ?? [], get.meta('resources') ?? [], {
				buildings: get.meta('buildings'),
				settlementKinds: get.meta('settlementKinds'),
			}),
	}),
];
