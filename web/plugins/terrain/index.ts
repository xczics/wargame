// Terrain in the browser: what a tile's ground gives, on the world map (map.ts).
import { defineClientPlugin } from '../../core/game';
import { mapPart } from './map';

export default defineClientPlugin({
	id: 'terrain',
	setup(game) {
		game.clientPart(mapPart);
	},
});
