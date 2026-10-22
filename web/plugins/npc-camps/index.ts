// NPC camps in the browser: what a camp's tile on the world map tells, and the camps rules place in the nearby list (map.ts).
import { defineClientPlugin } from '../../core/game';
import { mapPart, nearbyPart } from './map';

export default defineClientPlugin({
	id: 'npc-camps',
	setup(game) {
		game.clientPart(mapPart);
		game.clientPart(nearbyPart as never);
	},
});
