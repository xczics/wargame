// The pvp plugin in the browser: words its GM form from the data its `prepare` sends (./forms.ts).
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';

export default defineClientPlugin({
	id: 'pvp',
	setup(game) {
		for (const p of formParts) game.clientPart(p);
	},
});
