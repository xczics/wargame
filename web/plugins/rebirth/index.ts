// Rebirth in the browser: the stars on hero cards and the rebirth pill's form (./parts.ts).
import { defineClientPlugin } from '../../core/game';
import { parts } from './parts';

export default defineClientPlugin({
	id: 'rebirth',
	setup(game) {
		for (const p of parts) game.clientPart(p as never);
	},
});
