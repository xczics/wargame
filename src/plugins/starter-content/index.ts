/**
 * Default content: resources and buildings. The data is in ./data (CSV); this plugin only
 * hands it to the systems that own each format. New content should be added as more
 * plugins like this one, not by editing the system plugins.
 *
 * Each building has a planning table for levels 1-7 (cost, seconds); later levels grow
 * from the last row by `costGrowth` / `timeGrowth`. All of it is GM-tunable via `buildings.rules`.
 */
import { csvMap, csvRows, definePlugin, numberRecord, recordOf } from '../../kernel';
import baseProductionCsv from './data/base-production.csv?raw';
import buildingsCsv from './data/buildings.csv?raw';
import levelsCsv from './data/levels.csv?raw';
import resourcesCsv from './data/resources.csv?raw';

export default definePlugin({
	id: 'starter-content',
	version: '0.2.0',
	description: 'Stone, wood, food, metal, currency; resource, storage and civic buildings',
	dependsOn: ['resources', 'buildings', 'settlements'],
	setup(ctx) {
		const resources = ctx.services.get('resources');
		const settlements = ctx.services.get('settlements');
		resources.defineFromCsv(resourcesCsv);
		ctx.services.get('buildings').defineFromCsv(buildingsCsv, levelsCsv);

		// Built-in production by settlement kind (the anti-soft-lock income).
		const BASE = Object.fromEntries(csvRows(baseProductionCsv).map((r) => [r.kind, csvMap(r.produces)]));
		const baseProduction = ctx.config.define('baseProduction', {
			description: 'Built-in production per second by settlement kind (replaces the whole table), e.g. { "capital": { "food": 1 } }.',
			default: () => BASE,
			parse: recordOf(
				() => settlements.kinds().map((k) => k.id),
				numberRecord(() => resources.list().map((r) => r.id), 0, 1e9),
			),
		});
		resources.addProducer(async (api, holder) => {
			if (!holder.startsWith('settlement:')) return {};
			const s = await settlements.get(api, holder.slice('settlement:'.length));
			return (s && baseProduction.get(api)[s.kind]) ?? {};
		});
	},
});
