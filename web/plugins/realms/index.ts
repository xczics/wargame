// The Realms page's list and timers, assembled in the browser from `realms.overview` (./page.ts).
import { defineClientPlugin } from '../../core/game';
import { views } from './views';

export default defineClientPlugin({
	id: 'realms',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
	},
});
