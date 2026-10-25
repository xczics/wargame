// The starter-realms plugin in the browser: words its realm keys' forms from the data their `prepare` sends (./forms.ts),
// and adds its share of a hero's adventure numbers on the hero cards (./parts.ts).
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import { parts } from './parts';

export default defineClientPlugin({
	id: 'starter-realms',
	setup(game) {
		for (const p of [...formParts, ...parts]) game.clientPart(p);
	},
});
