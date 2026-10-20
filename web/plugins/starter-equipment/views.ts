// The starter-equipment plugin's views assembled in the browser (src/shared/client-views.ts).
import type { RealmsOverview, RealmsStatic } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { realmsInfo } from '../../../src/shared/realms';
import { shopRows } from './shop';

export const views = [
	defineClientView({
		id: 'starter-equipment.shop-rows',
		needs: ['realms.overview'],
		compute: (get) =>
			shopRows(realmsInfo(get.data<RealmsOverview>('realms.overview'), get.static<RealmsStatic>('realms.tasks')) ?? undefined),
	}),
];
