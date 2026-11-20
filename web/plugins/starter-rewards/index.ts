// The starter kinds of rewards in the browser: their words (a GM's mail's attachments, ./describe.ts) and what a claim
// of them changes in the data held here (./apply.ts).
import { defineClientPlugin } from '../../core/game';
import { applyParts } from './apply';
import { parts } from './describe';

export default defineClientPlugin({
	id: 'starter-rewards',
	setup(game) {
		for (const p of [...parts, ...applyParts]) game.clientPart(p);
	},
});
