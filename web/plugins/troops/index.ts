// The troops' screens made here from the server's data: the Army page's garrisons (./garrisons.ts) and each barracks'
// training queue on its entry (./training.ts).
import { defineClientPlugin } from '../../core/game';
import { views } from './views';

export default defineClientPlugin({
	id: 'troops',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
	},
});
