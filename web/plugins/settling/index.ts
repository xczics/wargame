// The settling plugin in the browser: words its expedition form from the data its `prepare` sends (./forms.ts).
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';

export default defineClientPlugin({
	id: 'settling',
	setup(game) {
		for (const p of formParts) game.clientPart(p);
	},
});
