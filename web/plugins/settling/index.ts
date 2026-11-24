// The settling plugin in the browser: words its expedition form from the data its `prepare` sends (./forms.ts).
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';

export default defineClientPlugin({
	id: 'settling',
	setup(game) {
		for (const p of formParts) game.clientPart(p);
		// An expedition sent: an army like any other (the armies' client part tells the data held here).
		game.afterCommand('settling.found', (_type, payload, reply, now) => game.use('armies').sent(payload, reply, now, 'settle'));
		game.afterCommand('settling.found', (_type, payload) => game.use('armies').answered(payload), { answered: true });
	},
});
