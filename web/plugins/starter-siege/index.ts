// The wall's entry made here from the server's data: what is being built there, the works and the defences; and how
// much faster a wall builds siege works, on its card (./effects.ts).
import type { SiegeRules, SiegeWallData } from '../../../src/shared/api';
import { type SiegeQueued, siegeCancelled, siegeOrdered } from '../../../src/shared/siege';
import { defineClientPlugin } from '../../core/game';
import { parts } from './effects';
import { formParts } from './forms';
import { views } from './views';

export default defineClientPlugin({
	id: 'starter-siege',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		for (const p of [...parts, ...formParts]) game.clientPart(p);
		// Ordered at the wall (here or from elsewhere, e.g. the assistant): into the wall held, with the id and end the answer
		// says ("starter-siege.queued": the queue and the wall's speed), what it paid from the rules.
		game.afterCommand(
			(t) => t === 'starter-siege.build' || t === 'starter-siege.fortify',
			(_t, payload, reply, now) => {
				const q = reply['starter-siege.queued'] as SiegeQueued | undefined;
				const rules = game.static<SiegeRules>('starter-siege.rules');
				if (!q || !rules) return game.markStale('starter-siege.wall');
				const p = payload as { settlement: string; device?: string; count?: number; work?: string };
				const order = p.work
					? { settlement: p.settlement, work: p.work }
					: { settlement: p.settlement, device: p.device!, count: Number(p.count) };
				let unknown = false;
				game.patchView<SiegeWallData | null>('starter-siege.wall', (d) => {
					if (!d) return d;
					const next = siegeOrdered(d, order, q, rules, now);
					if (next === null) unknown = true;
					return next ?? d;
				});
				if (unknown) game.markStale('starter-siege.wall');
			},
		);
		game.afterCommand('starter-siege.cancel', (_t, payload) =>
			game.patchView<SiegeWallData | null>('starter-siege.wall', (d) => d && siegeCancelled(d, (payload as { id: string }).id)),
		);
	},
});
