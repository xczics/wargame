// The equipment plugin's views assembled in the browser (src/shared/client-views.ts).
import type { EquipmentItems, EquipmentSmelt, EquipmentTotals, HeroAttributePart } from '../../../src/shared/api';
import { defineClientPart, defineClientView, type ClientViewGet } from '../../../src/shared/client-views';
import { statsUnder } from '../../../src/shared/equipment';
import { dollData } from './doll';
import { gearRows } from './gear';
import { equipmentState } from './state';

// By the rows object, the hero picked and the smelting table: the doll and the gear rows ask with the same after a sync.
const states = new WeakMap<EquipmentItems, { hero?: string; smelt?: EquipmentSmelt; state: ReturnType<typeof equipmentState> }>();
const state = (get: ClientViewGet) => {
	const items = get.data<EquipmentItems | null>('equipment.items');
	const smelt = get.static<EquipmentSmelt>('equipment.smelt');
	const hero = get.params.hero;
	const kept = items ? states.get(items) : undefined;
	if (kept && kept.hero === hero && kept.smelt === smelt) return kept.state;
	const out = equipmentState(
		items,
		hero,
		{ equipment: get.meta('equipment'), heroes: get.meta('heroes'), resources: get.meta('resources') },
		smelt,
	);
	if (items) states.set(items, { hero, smelt, state: out });
	return out;
};

export const views = [
	defineClientView({ id: 'equipment.gear', needs: ['equipment.items'], compute: (get) => gearRows(state(get)) }),
	defineClientView({ id: 'equipment.doll', needs: ['equipment.items'], compute: (get) => dollData(state(get)) }),
];

export const parts = [
	// On hero cards: what the gear worn adds to the attributes (its "attr." stats; battles add the same, server-side).
	defineClientPart<HeroAttributePart>({
		point: 'heroes.attributes',
		id: 'equipment',
		needs: ['equipment.totals'],
		part: (hero, get) => statsUnder(get.data<EquipmentTotals>('equipment.totals')?.[hero.id], 'attr.'),
	}),
];
