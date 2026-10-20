// Heroes in the browser: the Heroes page's cards, candidates and defence order, worked out from the heroes' data
// (the server sends data only; the widgets and their places are declared by the server plugin).
import { defineClientPlugin } from '../../core/game';
import { views } from './views';

export default defineClientPlugin({
	id: 'heroes',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
	},
});
