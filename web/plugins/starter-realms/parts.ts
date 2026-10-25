// The starter-realms plugin's share of a hero's adventure numbers on its card ("realms.heroStats"): its table of the
// attributes, baked into the static `starter-realms.heroStats` (the fights use the same `statsFromTable`).
import { defineClientPart } from '../../../src/shared/client-views';
import { type HeroStatsPart, type HeroStatsTable, statsFromTable } from '../../../src/shared/realms';

export const parts = [
	defineClientPart<HeroStatsPart>({
		point: 'realms.heroStats',
		id: 'starter-realms',
		part: (hero, get) => {
			const table = get.static<HeroStatsTable>('starter-realms.heroStats');
			return table ? statsFromTable(table, hero.attrs) : {};
		},
	}),
];
