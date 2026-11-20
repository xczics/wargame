// The realm shop's player part, assembled in the browser from `realms.overview` (./shop.ts), and the art of the
// equipment screen's paper doll (./art: two pixel figures and a sprite per set and slot).
import { defineClientPlugin } from '../../core/game';
import { starterArt } from './art';
import { parts } from './parts';
import { views } from './views';

export default defineClientPlugin({
	id: 'starter-equipment',
	dependsOn: ['equipment'],
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		for (const p of parts) game.clientPart(p);
		game.use('equipment').setArt(starterArt);
		// A piece bought in the realm shop, or a chest opened (items "chest-<set>-<colour>"): its id and stats are rolled
		// by the server, so the gear rows held here ask again where they show next (the current page's come with the answer).
		game.afterCommand(
			(type) => type === 'starter-equipment.buy' || type.startsWith('items.use.chest-'),
			() => {
				game.markStale('equipment.items');
				game.markStale('forms.patches');
			},
		);
	},
});
