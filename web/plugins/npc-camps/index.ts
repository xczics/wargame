// NPC camps in the browser: what a camp's tile on the world map tells, and the camps rules place in the nearby list (map.ts).
import { defineClientPlugin } from '../../core/game';
import { iconPart, mapPart, nearbyPart } from './map';

export default defineClientPlugin({
	id: 'npc-camps',
	setup(game) {
		game.clientPart(mapPart);
		game.clientPart(nearbyPart as never);
		game.clientPart(iconPart as never);
		// Troops sent to uproot a camp: an army like any other (the armies' client part tells the data held here).
		game.afterCommand('npc-camps.uproot', (_type, payload) => game.use('armies').sent(payload));
		game.afterCommand('npc-camps.uproot', (_type, payload) => game.use('armies').answered(payload), { answered: true });
	},
});
