// The settlements plugin's views assembled in the browser (src/shared/client-views.ts).
import type { SettlementOutline } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { districtBoard } from './districts';

export const views = [
	defineClientView({
		id: 'settlements.districts',
		needs: ['settlements.outline'],
		compute: (get) =>
			districtBoard(get.data<SettlementOutline | null>('settlements.outline'), get.meta('resources') ?? [], get.meta('map')),
	}),
];
