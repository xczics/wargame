// The equipment plugin's views assembled in the browser (src/shared/client-views.ts).
import type { EquipmentState } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { gearRows } from './gear';

export const views = [
	defineClientView({
		id: 'equipment.gear',
		needs: ['equipment.state'],
		compute: (get) => gearRows(get.data<EquipmentState | null>('equipment.state')),
	}),
];
