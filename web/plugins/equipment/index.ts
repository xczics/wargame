// Equipment in the browser: the gear rows worked out from the settlement's gear data (the server sends data only; the
// widgets and their places are declared by the server plugin).
import { defineClientPlugin } from '../../core/game';
import { views } from './views';

export default defineClientPlugin({
	id: 'equipment',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
	},
});
