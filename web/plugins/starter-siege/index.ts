// The wall's entry made here from the server's data: what is being built there, the works and the defences; and how
// much faster a wall builds siege works, on its card (./effects.ts).
import { staleUnlessAnswered } from '../../../src/shared/answered';
import { defineClientPlugin } from '../../core/game';
import { parts } from './effects';
import { formParts } from './forms';
import { views } from './views';

export default defineClientPlugin({
	id: 'starter-siege',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		for (const p of [...parts, ...formParts]) game.clientPart(p);
		// Ordered or cancelled at the wall from elsewhere (the assistant): its entry asks again when shown next.
		staleUnlessAnswered(game, (t) => ['starter-siege.build', 'starter-siege.fortify', 'starter-siege.cancel'].includes(t), [
			'starter-siege.wall',
		]);
	},
});
