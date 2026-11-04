// The troops plugin's views assembled in the browser (src/shared/client-views.ts).
import type { GarrisonInfo, ResourceMeta, TroopsState, UnitCatalog, UnitMeta, UnitStatsPart } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { garrisonRows } from './garrisons';
import { trainingTimers } from './training';

/** Where other client plugins word their units' hover (`UnitStatsPart`). */
export const UNIT_STATS = 'troops.unitStats';

export const views = [
	defineClientView({
		id: 'troops.garrisons',
		needs: ['troops.state'],
		points: [UNIT_STATS],
		compute: (get) =>
			garrisonRows(
				get.data<TroopsState>('troops.state'),
				get.meta<UnitMeta[]>('units'),
				get.meta<ResourceMeta[]>('resources'),
				get.static<UnitCatalog>('troops.units'),
				get.meta('battleFamilies'),
				{ parts: get.parts<UnitStatsPart>(UNIT_STATS), get },
			),
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
