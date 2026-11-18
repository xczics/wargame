// The starter trade routes' art in the browser: the portraits of the people their stories meet (./portraits.ts),
// given to the trade routes' screens by id (nodes.csv's `portrait` column on the server).
import { defineClientPlugin } from '../../core/game';
import { PORTRAITS } from './portraits';

export default defineClientPlugin({
	id: 'starter-trade-routes',
	dependsOn: ['trade-routes'],
	setup(game) {
		const routes = game.use('tradeRoutes');
		for (const [id, art] of Object.entries(PORTRAITS)) routes.addPortrait(id, art);
	},
});
