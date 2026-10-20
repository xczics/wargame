// The Army page's garrisons, assembled in the browser from the troops plugin's data (./garrisons.ts).
import { defineClientPlugin } from '../../core/game';
import { views } from './views';

export default defineClientPlugin({
	id: 'troops',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
	},
});
