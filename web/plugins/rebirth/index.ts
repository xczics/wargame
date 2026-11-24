// Rebirth in the browser: the stars on hero cards and the rebirth pill's form (./parts.ts). A pill used: whether it
// took is rolled by the server; when it did, the answer says what it rolled ("rebirth.reborn"), and the hero held here
// is reborn the same way (src/shared/heroes.ts `reincarnated`), its stars one more. A failure changes no hero.
import type { HeroesState, RebirthReborn, RebirthRules } from '../../../src/shared/api';
import { expToNextOf, type HeroGrowth, reincarnated } from '../../../src/shared/heroes';
import { defineClientPlugin } from '../../core/game';
import { PILL } from '../../../src/shared/rebirth';
import { parts, starred } from './parts';

export default defineClientPlugin({
	id: 'rebirth',
	dependsOn: ['heroes'],
	setup(game) {
		for (const p of parts) game.clientPart(p as never);
		game.afterCommand(`items.use.${PILL}`, (_t, _p, reply) => {
			const r = reply['rebirth.reborn'] as RebirthReborn | undefined;
			if (!r) return;
			const heroes = game.use('heroes');
			const h = heroes.get(r.hero);
			const growth = game.static<HeroGrowth>('heroes.growth');
			const rules = game.static<RebirthRules>('rebirth.rules');
			if (!h || !growth || !rules) return heroes.unknown();
			const after = reincarnated(h, r);
			heroes.update(r.hero, {
				attrs: after.attrs,
				talents: after.talents,
				talent: after.talent,
				alloc: after.alloc,
				level: after.level,
				exp: after.exp,
				expToNext: expToNextOf(growth, after.level),
				freePoints: after.freePoints,
			});
			// The card's stars (its data from this plugin: how often reborn).
			game.patchView<HeroesState>('heroes.state', (s) => starred(s, r.hero, rules.max));
		});
	},
});
