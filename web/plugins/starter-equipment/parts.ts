// What the gear adds to a hero's adventure numbers ("realms.heroStats"): its "adv." stats, from the sums
// `equipment.totals` forwards (the fights add the same, server-side).
import type { EquipmentTotals } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { statsUnder } from '../../../src/shared/equipment';
import type { HeroStatsPart } from '../../../src/shared/realms';

export const parts = [
	defineClientPart<HeroStatsPart>({
		point: 'realms.heroStats',
		id: 'starter-equipment',
		needs: ['equipment.totals'],
		part: (hero, get) => statsUnder(get.data<EquipmentTotals>('equipment.totals')?.[hero.id], 'adv.'),
	}),
];
