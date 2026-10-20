// The starter-defense plugin in the browser: words what walls and hidden stores do on their cards (./effects.ts).
import { defineClientPlugin } from '../../core/game';
import { parts } from './effects';

export default defineClientPlugin({
	id: 'starter-defense',
	setup(game) {
		for (const p of parts) game.clientPart(p);
	},
});
