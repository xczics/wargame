// NPC camps in the browser: what a camp's tile on the world map tells (map.ts).
import { defineClientPlugin } from '../../core/game';
import { mapPart } from './map';

export default defineClientPlugin({
	id: 'npc-camps',
	setup(game) {
		game.clientPart(mapPart);
	},
});
