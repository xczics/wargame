// The starter auxiliary units in the browser: their hover on the Army page (./stats.ts); the carts' pace, as the server
// plugin's pace modifier (the shared rule), for the marches the browser times.
import type { AuxiliaryUnits } from '../../../src/shared/api';
import { cartPace } from '../../../src/shared/starter-auxiliary';
import { defineClientPlugin } from '../../core/game';
import { parts } from './stats';

/** The carts' seats by unit, once per static version. */
const seatsOf = new WeakMap<AuxiliaryUnits, Record<string, number>>();

export default defineClientPlugin({
	id: 'starter-auxiliary',
	dependsOn: ['troops', 'armies'],
	setup(game) {
		for (const p of parts) game.clientPart(p);
		game.use('armies').addPaceModifier((units, speedOf) => {
			const aux = game.static<AuxiliaryUnits>('starter-auxiliary.units');
			if (!aux) return undefined;
			let seats = seatsOf.get(aux);
			if (!seats) {
				seats = Object.fromEntries(Object.entries(aux).flatMap(([id, a]) => (a.role === 'cart' ? [[id, a.seats]] : [])));
				seatsOf.set(aux, seats);
			}
			return cartPace(units, speedOf, seats);
		});
	},
});
