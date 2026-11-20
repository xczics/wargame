// The starter trade routes' art in the browser: the portraits of the people their stories meet (./portraits.ts),
// given to the trade routes' screens by id (nodes.csv's `portrait` column on the server), and the faces of everyone
// else (the player's heroes, enemy generals) drawn from a seed.
import { defineClientPlugin } from '../../core/game';
import { FOE_NAMES_ZH, FOES } from './foes';
import { face, PORTRAITS } from './portraits';

export default defineClientPlugin({
	id: 'starter-trade-routes',
	dependsOn: ['trade-routes'],
	setup(game) {
		const routes = game.use('tradeRoutes');
		for (const [id, art] of Object.entries(PORTRAITS)) routes.addPortrait(id, art);
		routes.setFaces(face);
		// The enemies' names chapter by chapter (./foes.ts), as this plugin's words.
		game.messages('en', Object.fromEntries(Object.keys(FOE_NAMES_ZH).map((k) => [k, k])));
		game.messages('zh-CN', FOE_NAMES_ZH);
		for (const [at, names] of Object.entries(FOES)) {
			const [route, chapter] = at.split('/');
			routes.setFoes(
				route,
				Number(chapter),
				Object.fromEntries(Object.entries(names).map(([family, name]) => [family, `@starter-trade-routes.${name}`])),
			);
		}
	},
});
