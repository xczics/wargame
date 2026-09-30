/**
 * Default research content, plus the Institute building where research happens. The data
 * is in ./data (CSV): each resource building's levels 6-20 are gated in three bands by its
 * tech (level 1: 6-10, level 2: 11-15, level 3: 16-20), so fully researched means the
 * regular cap of 20; two general techs add outer cities and production.
 */
import { definePlugin } from '../../kernel';
import buildingLevelsCsv from './data/building-levels.csv?raw';
import buildingsCsv from './data/buildings.csv?raw';
import levelsCsv from './data/levels.csv?raw';
import techsCsv from './data/techs.csv?raw';

export default definePlugin({
	id: 'starter-research',
	version: '0.2.0',
	description: 'Building techs (levels 6-20) plus administration and economics',
	dependsOn: ['research', 'buildings'],
	setup(ctx) {
		ctx.services.get('buildings').defineFromCsv(buildingsCsv, buildingLevelsCsv);
		ctx.services.get('research').defineFromCsv(techsCsv, levelsCsv);
	},
});
