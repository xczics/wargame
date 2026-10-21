// The starter-realms plugin in the browser: words its realm keys' forms from the data their `prepare` sends (./forms.ts).
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';

export default defineClientPlugin({
	id: 'starter-realms',
	setup(game) {
		for (const p of formParts) game.clientPart(p);
	},
});
