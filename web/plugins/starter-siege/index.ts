// The wall's entry made here from the server's data: what is being built there, the works and the defences.
import { defineClientPlugin } from '../../core/game';
import { views } from './views';

export default defineClientPlugin({
	id: 'starter-siege',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
	},
});
