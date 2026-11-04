// The City page's building cards at any level: built in the browser from the static data of `buildings.catalog`
// (tables and rules) by the same functions the server quotes with (src/shared/buildings.ts); the player's view only
// says which building and level each slot has.
import type { BuildingsState } from '../../../src/shared/api';
import { buildingTemplate } from '../../../src/shared/buildings';
import { defineTemplates } from '../../../src/shared/statics';
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import { views } from './views';

export default defineClientPlugin({
	id: 'buildings',
	setup(game) {
		defineTemplates('buildings', buildingTemplate);
		for (const v of views) game.clientView(v.id, v);
		for (const p of formParts) game.clientPart(p);
		// A slot's level now ("slot-level:<settlement>/<district>/<slot>", a building entry's id), from the settlement's
		// state held here: for what shows only from some level on (e.g. "entry:building?slot-level:{id}>=20").
		game.provideCounter('slot-level:', (id) => {
			const [settlement, district, slot] = id.split('/');
			const state = game.held<BuildingsState | null>('buildings.state').find((x) => x.value?.settlement.id === settlement)?.value;
			return state?.slots.find((x) => x.district === district && String(x.slot) === slot)?.level ?? (state ? 0 : undefined);
		});
	},
});
