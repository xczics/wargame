/**
 * Default research content, plus the Institute building where research happens.
 * Each resource building's levels 6-20 are gated in three
 * bands by its tech (level 1: 6-10, level 2: 11-15, level 3: 16-20); fully researched
 * means the regular cap of 20. Two general techs add outer cities and production.
 */
import { definePlugin } from '../../kernel';
import type { LevelRow } from '../buildings';
import type { Cost } from '../resources';

const table = (...rows: [Cost, number][]): LevelRow[] => rows.map(([cost, seconds]) => ({ cost, seconds }));
const band = (...buildings: string[]) => buildings.map((building) => ({ building, from: 6, perLevel: 5 }));
const gateLevels = table(
	[{ food: 600, wood: 600, stone: 600, gold: 300 }, 300],
	[{ food: 3000, wood: 3000, stone: 3000, gold: 1500 }, 3600],
	[{ food: 12000, wood: 12000, stone: 12000, gold: 6000 }, 21600],
);

export default definePlugin({
	id: 'starter-research',
	version: '0.1.0',
	description: 'Building techs (levels 6-20) plus administration and economics',
	dependsOn: ['research', 'buildings'],
	setup(ctx) {
		const research = ctx.services.get('research');

		// Research happens here: one per settlement; each level makes research 10% faster.
		ctx.services.get('buildings').define({
			id: 'institute',
			name: 'Institute',
			icon: '🔬',
			category: 'civic',
			unique: true,
			stats: { 'research.labs': 1, 'research.speed': 0.1 },
			levels: table(
				[{ food: 200, wood: 300, stone: 250, gold: 100 }, 60],
				[{ food: 400, wood: 550, stone: 450, gold: 200 }, 180],
				[{ food: 750, wood: 1000, stone: 800, gold: 400 }, 480],
				[{ food: 1400, wood: 1800, stone: 1450, gold: 750 }, 1200],
				[{ food: 2500, wood: 3200, stone: 2600, gold: 1400 }, 3000],
				[{ food: 4500, wood: 5800, stone: 4700, gold: 2500 }, 7200],
				[{ food: 8000, wood: 10400, stone: 8400, gold: 4500 }, 16800],
			),
		});
		research.define({
			id: 'agriculture',
			name: 'Agriculture',
			description: 'Farm levels 6-20',
			maxLevel: 3,
			levels: gateLevels,
			unlocks: band('farm'),
		});
		research.define({
			id: 'forestry',
			name: 'Forestry',
			description: 'Lumber mill levels 6-20',
			maxLevel: 3,
			levels: gateLevels,
			unlocks: band('lumber-mill'),
		});
		research.define({
			id: 'masonry',
			name: 'Masonry',
			description: 'Quarry and warehouse levels 6-20',
			maxLevel: 3,
			levels: gateLevels,
			unlocks: band('quarry', 'warehouse'),
		});
		research.define({
			id: 'mining',
			name: 'Mining',
			description: 'Gold mine levels 6-20',
			maxLevel: 3,
			levels: gateLevels,
			unlocks: band('gold-mine'),
		});
		research.define({
			id: 'administration',
			name: 'Administration',
			description: '+1 outer city per level (research alone reaches at most 8)',
			maxLevel: 3,
			requires: { agriculture: 1 },
			levels: table(
				[{ food: 1500, wood: 1500, stone: 1500, gold: 800 }, 1800],
				[{ food: 6000, wood: 6000, stone: 6000, gold: 3000 }, 14400],
			),
			stats: { 'settlements.outer.tech': 1 },
		});
		research.define({
			id: 'economics',
			name: 'Economics',
			description: '+5% production per level',
			maxLevel: 5,
			levels: table([{ food: 800, wood: 800, stone: 800, gold: 400 }, 600]),
			percent: { 'resources.productionFactor': 5 },
		});
	},
});
