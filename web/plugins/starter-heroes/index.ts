// The starter heroes' screens: their posts in a settlement (rows on the city page and on buildings' entries), made
// here from the server's data.
import { defineClientPlugin } from '../../core/game';
import { views } from './views';

export default defineClientPlugin({
	id: 'starter-heroes',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
	},
});
