// The shop: its page's cards worked out here over the static offers from the player's wallet (`shop.wallet`); where
// they show is the server plugin's layout (generic widgets).
import { defineClientPlugin } from '../../core/game';
import { views } from './views';

export default defineClientPlugin({
	id: 'shop',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
	},
});
