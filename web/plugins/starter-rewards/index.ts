// The starter kinds of rewards in the browser: their words (a GM's mail's attachments, ./describe.ts).
import { defineClientPlugin } from '../../core/game';
import { parts } from './describe';

export default defineClientPlugin({
	id: 'starter-rewards',
	setup(game) {
		for (const p of parts) game.clientPart(p);
	},
});
