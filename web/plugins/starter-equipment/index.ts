// The realm shop's player part, assembled in the browser from `realms.overview` (./shop.ts).
import { defineClientPlugin } from '../../core/game';
import { views } from './views';

export default defineClientPlugin({
	id: 'starter-equipment',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
	},
});
