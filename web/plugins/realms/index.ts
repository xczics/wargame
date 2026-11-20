// The Realms page's list and timers, assembled in the browser from `realms.overview` (./page.ts); a line on the hero
// cards ("heroes.card"). What commands did to the heroes and adventures is told to the overview held here at once
// (./patch.ts).
import type { RealmsOverview } from '../../../src/shared/api';
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import { healing, heroChanged, heroGone } from './patch';
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
			unknown: () => game.markStale('realms.overview'),
		});
		// Set out: the hero is away at once; the adventure itself (its id, when it ends: the fights) only the server knows.
		game.afterCommand(ADVENTURE, (_t, payload) => {
			heroes.update((payload as { hero: string }).hero, { duty: ADVENTURE, dutyTarget: null });
			game.markStale('realms.overview');
		});
		game.afterCommand('realms.heal', (_t, payload) => {
			const hero = (payload as { hero: string }).hero;
			game.patchView<RealmsOverview>('realms.overview', (o) => healing(o, hero, game.serverNow()));
		});
	},
});
