// The Army page's protection from bandits, assembled in the browser from the bandits plugin's data (./views.ts).
import { defineClientPlugin } from '../../core/game';
import { views } from './views';

export default defineClientPlugin({
	id: 'bandits',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
	},
});
