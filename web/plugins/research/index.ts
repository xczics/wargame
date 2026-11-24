// Research: the tech tree's views worked out here from the player's part (`research.state`) and the static tree
// (`research.techs`); where they show is the server plugin's layout (generic widgets).
import type { ResearchState } from '../../../src/shared/api';
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import { parts as knownParts } from './known';
import { researchStarted } from './patches';
import { views } from './views';

export default defineClientPlugin({
	id: 'research',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		for (const p of [...formParts, ...knownParts]) game.clientPart(p);
		// Started (here or from elsewhere, e.g. the assistant): the job into the research held here, ending when the answer
		// says ("research.finishesAt": that settlement's modifiers only the server has for sure).
		game.afterCommand('research.start', (_t, payload, reply, now) => {
			const p = payload as { settlement: string; tech: string };
			const finishesAt = reply['research.finishesAt'];
			if (typeof finishesAt !== 'number') return game.markStale('research.state');
			const name = game.view('settlements.mine')?.find((s) => s.id === p.settlement)?.name;
			game.patchView<ResearchState>('research.state', (s) => researchStarted(s, p, { now, finishesAt, name }));
		});
	},
});
