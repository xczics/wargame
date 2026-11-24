// The Realms page's list and timers, assembled in the browser from `realms.overview` (./page.ts); a line on the hero
// cards ("heroes.card"). What commands did to the heroes and adventures is told to the overview held here at once
// (./patch.ts).
import type { AdventureSent, RealmsOverview } from '../../../src/shared/api';
import { nameKey } from '../../../src/shared/heroes';
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import { healing, heroChanged, heroGone, setOut } from './patch';
import { parts, views } from './views';

/** The realms plugin's duty for a hero away on an adventure (src/plugins/realms). */
const ADVENTURE = 'realms.adventure';

export default defineClientPlugin({
	id: 'realms',
	dependsOn: ['heroes'],
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		for (const p of formParts) game.clientPart(p);
		for (const p of parts) game.clientPart(p);

		// The overview's heroes follow what commands did to them wherever they were sent (user 2026-11-20: a hero put on a
		// post on the Heroes page still showed as free on the Realms page).
		const heroes = game.use('heroes');
		heroes.listen({
			changed: (id, change) => game.patchView<RealmsOverview>('realms.overview', (o) => heroChanged(o, id, change)),
			removed: (id) => game.patchView<RealmsOverview>('realms.overview', (o) => heroGone(o, id)),
			// Recruited: one more hero to send, as the server lists it (name key, level, idle, its own attributes).
			added: (h) =>
				game.patchView<RealmsOverview>('realms.overview', (o) =>
					o.heroes.some((x) => x.id === h.id)
						? o
						: {
								...o,
								heroes: [...o.heroes, { id: h.id, name: nameKey(h), level: h.level, idle: h.duty === 'idle', attrs: { ...h.attrs } }],
							},
				),
			unknown: () => game.markStale('realms.overview'),
		});
		// Set out: the hero is away at once on that adventure; its id and end (the fights) the answer says ("realms.adventure").
		game.afterCommand(ADVENTURE, (_t, payload, reply, now) => {
			const p = payload as { hero: string; realm: string; task: number; repeat?: number };
			const sent = reply[ADVENTURE] as AdventureSent | undefined;
			heroes.update(p.hero, { duty: ADVENTURE, dutyTarget: sent?.id ?? null });
			if (sent) game.patchView<RealmsOverview>('realms.overview', (o) => setOut(o, p, sent, now));
			else game.markStale('realms.overview');
		});
		game.afterCommand('realms.heal', (_t, payload, _r, now) => {
			const hero = (payload as { hero: string }).hero;
			game.patchView<RealmsOverview>('realms.overview', (o) => healing(o, hero, now));
		});
	},
});
