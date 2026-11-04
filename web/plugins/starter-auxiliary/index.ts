// The starter auxiliary units in the browser: their hover on the Army page (./stats.ts).
import { defineClientPlugin } from '../../core/game';
import { parts } from './stats';

export default defineClientPlugin({
	id: 'starter-auxiliary',
	dependsOn: ['troops'],
	setup(game) {
		for (const p of parts) game.clientPart(p);
	},
});
