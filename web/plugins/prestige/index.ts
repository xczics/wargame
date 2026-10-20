// The player's rank and prestige by the user name, made here from the server's data.
import { defineClientPlugin } from '../../core/game';
import { views } from './views';

export default defineClientPlugin({
	id: 'prestige',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
	},
});
