// The Realms page's list and timers, assembled in the browser from `realms.overview` (./page.ts); a line on the hero
// cards ("heroes.card").
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import { parts, views } from './views';

export default defineClientPlugin({
	id: 'realms',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		for (const p of formParts) game.clientPart(p);
		for (const p of parts) game.clientPart(p);
	},
});
