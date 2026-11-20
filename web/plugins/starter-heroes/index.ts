// The starter heroes' screens: their posts in a settlement (rows on the city page and on buildings' entries), made
// here from the server's data and the heroes held here; what a hero would give in each role, on its card ("heroes.card").
import type { HeroEffectsStatic } from '../../../src/shared/starter-heroes';
import { defineClientPlugin } from '../../core/game';
import { parts, views } from './views';

/**
 * What the heroes on posts change elsewhere (src/plugins/starter-heroes: production, construction, training, upkeep,
 * research): worked out by the server with every other source, so those views ask again where they show next once
 * someone takes or leaves a post, or a hero on one grows stronger.
 */
const AFFECTED = ['resources.sources', 'buildings.state', 'troops.garrison', 'troops.state', 'research.state'];

export default defineClientPlugin({
	id: 'starter-heroes',
	dependsOn: ['heroes'],
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		for (const p of parts) game.clientPart(p);
		const posts = () => {
			const rows = game.static<HeroEffectsStatic>('starter-heroes.effects')?.rows ?? [];
			return new Set(rows.map((r) => r.duty).filter((d) => d !== 'command' && d !== 'defend'));
		};
		const heroes = game.use('heroes');
		const stale = () => AFFECTED.forEach((v) => game.markStale(v));
		heroes.listen({
			changed(_id, change, hero) {
				const onPost = !!hero && posts().has(hero.duty);
				if (change.duty !== undefined || change.home !== undefined || (onPost && (change.attrs || change.level !== undefined))) stale();
			},
		});
	},
});
