// The wall's entry made here from the server's data: what is being built there, the works and the defences; and how
// much faster a wall builds siege works, on its card (./effects.ts).
import { defineClientPlugin } from '../../core/game';
import { parts } from './effects';
import { views } from './views';

export default defineClientPlugin({
	id: 'starter-siege',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		for (const p of parts) game.clientPart(p);
	},
});
