// Research: the tech tree's views worked out here from the player's part (`research.state`) and the static tree
// (`research.techs`); where they show is the server plugin's layout (generic widgets).
import { defineClientPlugin } from '../../core/game';
import { views } from './views';

export default defineClientPlugin({
	id: 'research',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
	},
});
