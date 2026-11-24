// Research: the tech tree's views worked out here from the player's part (`research.state`) and the static tree
// (`research.techs`); where they show is the server plugin's layout (generic widgets).
import type { ResearchState } from '../../../src/shared/api';
import { type ResearchCatalog, techQuote } from '../../../src/shared/research';
import type { TreeData } from '../../../src/shared/ui';
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
		// Started (here or from elsewhere, e.g. the assistant): the job into the research held here, ending when the same
		// quote as the server's says (shared `techQuote`, that settlement's lab speed and factors from its research part,
		// the static tree): the browser knows it (user 2026-11-24: "研究完成时间……这些前端是知道的呀"). That settlement's
		// part not held (never opened there): asked again where it shows next.
		game.afterCommand('research.start', (_t, payload, _reply, now) => {
			const p = payload as { settlement: string; tech: string };
			const catalog = game.static<TreeData>('research.techs')?.data as ResearchCatalog | undefined;
			const held = game
				.held<ResearchState | null>('research.state')
				.filter((x) => x.params.settlement === p.settlement && x.value?.here)
				.sort((a, b) => b.at - a.at)[0]?.value;
			const plan = catalog && held ? [...catalog.techs, ...(held.own ?? [])].find((x) => x.id === p.tech) : undefined;
			if (!catalog || !held?.here || !plan) return game.markStale('research.state');
			const here = held.here;
			const f = here.factors.techs?.[p.tech] ?? here.factors;
			const level = (held.levels[p.tech] ?? 0) + 1;
			const { seconds } = techQuote(plan, level, catalog, { labSpeed: here.labSpeed, costFactor: f.cost, timeFactor: f.time });
			const finishesAt = now + seconds * 1000;
			const name = game.view('settlements.mine')?.find((s) => s.id === p.settlement)?.name;
			game.patchView<ResearchState>('research.state', (s) => researchStarted(s, p, { now, finishesAt, name }));
		});
	},
});
