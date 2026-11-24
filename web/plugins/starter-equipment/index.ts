// The realm shop's player part, assembled in the browser from `realms.overview` (./shop.ts), and the art of the
// equipment screen's paper doll (./art: two pixel figures and a sprite per set and slot).
import { accessoriesOf, type StarterAccessories } from '../../../src/shared/starter-equipment';
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
		// How many accessories a heroine wears, for a hero the browser made (a recruit): the server's rule, the content's
		// highest from the static. (A piece bought or a chest opened comes whole with the answer: "equipment.created".)
		game.use('equipment').setGroupLimit('accessory', (h) => {
			const s = game.static<StarterAccessories>('starter-equipment.accessories');
			return s ? accessoriesOf(h, s.max) : undefined;
		});
	},
});
