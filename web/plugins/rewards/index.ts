// Rewards in the browser: the pool kind's words (./describe.ts); the other kinds' come from the plugins defining them.
import { defineClientPlugin } from '../../core/game';
import { parts } from './describe';

export default defineClientPlugin({
	id: 'rewards',
	setup(game) {
		for (const p of parts) game.clientPart(p);
	},
});
