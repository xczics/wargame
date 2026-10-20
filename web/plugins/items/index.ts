// Items: the Items page's cards and the item buttons elsewhere, worked out here from what the player has
// (`items.owned`, `items.extra`) and the statics; where they show is the server plugin's layout (generic widgets).
import { defineClientPlugin } from '../../core/game';
import { views } from './views';

export default defineClientPlugin({
	id: 'items',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
	},
});
