// The City page's building cards at any level: built in the browser from the static data of `buildings.catalog`
// (tables and rules) by the same functions the server quotes with (src/shared/buildings.ts); the player's view only
// says which building and level each slot has.
import type { BuildingsState } from '../../../src/shared/api';
import type { CardsData } from '../../../src/shared/ui';
import { type BuildingCatalog, buildingTemplate } from '../../../src/shared/buildings';
import { defineTemplates } from '../../../src/shared/statics';
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import { cancelled, constructed, demolished, type SlotOrder } from './patches';
import { views } from './views';

export default defineClientPlugin({
	id: 'buildings',
	setup(game) {
		defineTemplates('buildings', buildingTemplate);
		for (const v of views) game.clientView(v.id, v);
		for (const p of formParts) game.clientPart(p);
		// Built, cancelled or torn down (here or from elsewhere, e.g. the assistant): the settlement's buildings held here
		// follow at once, the times worked out as the server does from the clock the command ran at (./patches.ts).
		const order = (payload: unknown): SlotOrder => {
			const p = payload as SlotOrder;
			return { ...p, slot: Number(p.slot) };
		};
		const catalog = () => game.static<CardsData>('buildings.catalog')?.data as BuildingCatalog | undefined;
		game.afterCommand('buildings.construct', (_t, payload, _r, now) => {
			const c = catalog();
			if (c) game.patchView<BuildingsState | null>('buildings.state', (s) => s && constructed(s, order(payload), c, now));
		});
		game.afterCommand('buildings.demolish', (_t, payload, _r, now) => {
			const c = catalog();
			if (c) game.patchView<BuildingsState | null>('buildings.state', (s) => s && demolished(s, order(payload), c, now));
		});
		game.afterCommand('buildings.cancel', (_t, payload) =>
			game.patchView<BuildingsState | null>('buildings.state', (s) => s && cancelled(s, order(payload))),
		);
		// A slot's level now ("slot-level:<settlement>/<district>/<slot>", a building entry's id), from the settlement's
		// state held here: for what shows only from some level on (e.g. "entry:building?slot-level:{id}>=20").
		game.provideCounter('slot-level:', (id) => {
			const [settlement, district, slot] = id.split('/');
			const state = game.held<BuildingsState | null>('buildings.state').find((x) => x.value?.settlement.id === settlement)?.value;
			return state?.slots.find((x) => x.district === district && String(x.slot) === slot)?.level ?? (state ? 0 : undefined);
		});
	},
});
