// The starter-army plugin in the browser: words a barracks' training speed-up on its card (./effects.ts).
import { defineClientPlugin } from '../../core/game';
import { parts } from './effects';

export default defineClientPlugin({
	id: 'starter-army',
	setup(game) {
		for (const p of parts) game.clientPart(p);
	},
});
