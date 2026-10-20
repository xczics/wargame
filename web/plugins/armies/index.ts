// The Army page's incoming attacks and marches, assembled in the browser from the armies plugin's data (./timers.ts).
import { defineClientPlugin } from '../../core/game';
import { views } from './views';

export default defineClientPlugin({
	id: 'armies',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
	},
});
