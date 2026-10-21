// The starter-levies plugin in the browser: words its levy orders' forms from the data their `prepare` sends (./forms.ts).
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';

export default defineClientPlugin({
	id: 'starter-levies',
	setup(game) {
		for (const p of formParts) game.clientPart(p);
	},
});
