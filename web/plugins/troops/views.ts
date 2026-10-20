// The troops plugin's views assembled in the browser (src/shared/client-views.ts).
import type { ResourceMeta, TroopsState, UnitMeta } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { garrisonRows } from './garrisons';

export const views = [
	defineClientView({
		id: 'troops.garrisons',
		needs: ['troops.state'],
		compute: (get) =>
			garrisonRows(get.data<TroopsState>('troops.state'), get.meta<UnitMeta[]>('units'), get.meta<ResourceMeta[]>('resources')),
	}),
];
