// The buildings plugin's views assembled in the browser (src/shared/client-views.ts).
import type { BuildingsState } from '../../../src/shared/api';
import type { BuildingCatalog } from '../../../src/shared/buildings';
import { defineClientView } from '../../../src/shared/client-views';
import type { CardsData } from '../../../src/shared/ui';
import { slotCards } from './slots';

export const views = [
	defineClientView({
		id: 'buildings.slots',
		needs: ['buildings.state'],
		compute: (get) =>
			slotCards(
				get.data<BuildingsState | null>('buildings.state'),
				get.static<CardsData>('buildings.catalog')?.data as BuildingCatalog | undefined,
			),
	}),
];
