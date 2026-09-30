/**
 * Default content: resources and buildings. Pure data — new content should be added as
 * more plugins like this one, not by editing the system plugins.
 *
 * Each building has a planning table for levels 1-7 (cost, seconds); later levels grow
 * from row 7 by `costGrowth` / `timeGrowth`. All of it is GM-tunable via `buildings.rules`.
 */
import { definePlugin } from '../../kernel';
import type { LevelRow } from '../buildings';
import type { Cost } from '../resources';

/** Compact planning table: [cost, seconds] per level. */
const table = (...rows: [Cost, number][]): LevelRow[] => rows.map(([cost, seconds]) => ({ cost, seconds }));

export default definePlugin({
	id: 'starter-content',
	version: '0.2.0',
	description: 'Food, wood, stone, gold; resource, storage and civic buildings',
	dependsOn: ['resources', 'buildings', 'troops'],
	setup(ctx) {
		const resources = ctx.services.get('resources');
		const buildings = ctx.services.get('buildings');
		const troops = ctx.services.get('troops');

		resources.define({ id: 'food', name: 'Food', icon: '🌾', initial: 500 });
		resources.define({ id: 'wood', name: 'Wood', icon: '🪵', initial: 500 });
		resources.define({ id: 'stone', name: 'Stone', icon: '🪨', initial: 500 });
		resources.define({ id: 'gold', name: 'Gold', icon: '🪙', initial: 200 });

		// Resource buildings: outer cities and resource fortresses only.
		const producer = (id: string, name: string, icon: string, resource: string, perLevel: number, main: string) =>
			buildings.define({
				id,
				name,
				icon,
				category: 'resource',
				produces: { [resource]: perLevel },
				levels: table(
					[{ [main]: 40, wood: 60 }, 10],
					[{ [main]: 70, wood: 100 }, 25],
					[{ [main]: 120, wood: 170 }, 60],
					[{ [main]: 200, wood: 280 }, 150],
					[{ [main]: 330, wood: 460, stone: 100 }, 360],
					[{ [main]: 540, wood: 750, stone: 200 }, 900],
					[{ [main]: 880, wood: 1200, stone: 400 }, 2100],
				),
			});
		producer('farm', 'Farm', '🌾', 'food', 1, 'food');
		producer('lumber-mill', 'Lumber Mill', '🪓', 'wood', 1, 'stone');
		producer('quarry', 'Quarry', '⛏️', 'stone', 0.8, 'food');
		producer('gold-mine', 'Gold Mine', '🪙', 'gold', 0.3, 'stone');

		buildings.define({
			id: 'warehouse',
			name: 'Warehouse',
			icon: '🏚️',
			category: 'storage',
			// Also hides some of every resource from raiders (if the pvp plugin is enabled).
			stats: { 'resources.capacity': 2000, 'pvp.protected': 500 },
			levels: table(
				[{ wood: 150, stone: 100 }, 20],
				[{ wood: 260, stone: 180 }, 50],
				[{ wood: 450, stone: 320 }, 120],
				[{ wood: 780, stone: 560 }, 300],
				[{ wood: 1350, stone: 980 }, 720],
				[{ wood: 2300, stone: 1700 }, 1700],
				[{ wood: 4000, stone: 3000 }, 4000],
			),
		});

		// One per capital; each level raises the outer-city research limit by one (3 + 5 = 8 = a full 3x3).
		const seat = (id: string, name: string, icon: string, kind: string) =>
			buildings.define({
				id,
				name,
				icon,
				category: 'civic',
				kinds: [kind],
				unique: true,
				cap: 5,
				stats: { 'settlements.outer.tech': 1 },
				levels: table(
					[{ food: 300, wood: 300, stone: 300, gold: 100 }, 60],
					[{ food: 800, wood: 800, stone: 800, gold: 250 }, 600],
					[{ food: 2000, wood: 2000, stone: 2000, gold: 600 }, 3600],
					[{ food: 5000, wood: 5000, stone: 5000, gold: 1500 }, 14400],
					[{ food: 12000, wood: 12000, stone: 12000, gold: 3500 }, 43200],
				),
			});
		seat('palace', 'Palace', '🏰', 'capital');
		seat('town-hall', 'Town Hall', '🏛️', 'city'); // the city counterpart of the palace

		// Needed to train troops (see the units below).
		buildings.define({
			id: 'barracks',
			name: 'Barracks',
			icon: '⚔️',
			category: 'military',
			unique: true,
			levels: table(
				[{ food: 200, wood: 250, stone: 150 }, 30],
				[{ food: 350, wood: 430, stone: 260 }, 90],
				[{ food: 600, wood: 740, stone: 450 }, 240],
				[{ food: 1000, wood: 1270, stone: 780 }, 600],
				[{ food: 1750, wood: 2200, stone: 1350 }, 1500],
				[{ food: 3000, wood: 3800, stone: 2300 }, 3600],
				[{ food: 5200, wood: 6500, stone: 4000 }, 8400],
			),
		});

		// Units. Everyone eats; professional soldiers also want pay.
		troops.define({
			id: 'militia',
			name: 'Militia',
			icon: '🗡️',
			cost: { food: 30, wood: 10 },
			seconds: 5,
			upkeep: { food: 0.02 },
			attack: 5,
			defense: 8,
			speed: 12,
			carry: 20,
			requires: { building: 'barracks', level: 1 },
		});
		troops.define({
			id: 'spearman',
			name: 'Spearman',
			icon: '🔱',
			cost: { food: 50, wood: 40, stone: 20, gold: 10 },
			seconds: 12,
			upkeep: { food: 0.04, gold: 0.01 },
			attack: 12,
			defense: 15,
			speed: 9,
			carry: 35,
			requires: { building: 'barracks', level: 2 },
		});
	},
});
