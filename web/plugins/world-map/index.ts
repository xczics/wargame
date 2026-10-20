// The world map's grid, assembled here (views.ts) from the window's data. Other client plugins draw their part of it
// (the settlements, the camps...) as client parts at "world-map.layer", for the data their server plugin sends.
import { defineClientPlugin } from '../../core/game';
import { views } from './views';

export default defineClientPlugin({
	id: 'world-map',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
	},
});
