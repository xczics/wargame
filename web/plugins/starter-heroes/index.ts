// The starter heroes' screens: their posts in a settlement (rows on the city page and on buildings' entries), made
// here from the server's data; what a hero would give in each role, on its card ("heroes.card").
import { defineClientPlugin } from '../../core/game';
import { parts, views } from './views';

export default defineClientPlugin({
	id: 'starter-heroes',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		for (const p of parts) game.clientPart(p);
	},
});
