// The resources plugin's views assembled in the browser (src/shared/client-views.ts).
import type { ProductionRows, ResourcePool } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { productionTable } from './production';

export const views = [
	defineClientView({
		id: 'resources.production',
		needs: ['resources.sources', 'resources.pool'],
		compute: (get) =>
			productionTable(
				get.data<ProductionRows | null>('resources.sources'),
				get.data<ResourcePool | null>('resources.pool'),
				get.meta('resources') ?? [],
			),
	}),
];
