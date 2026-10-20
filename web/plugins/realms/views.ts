// The realms plugin's views assembled in the browser (src/shared/client-views.ts).
import type { HeroCardPart, RealmsCatalog, RealmsOverview } from '../../../src/shared/api';
import { defineClientPart, defineClientView } from '../../../src/shared/client-views';
import type { AdventureStats } from '../../../src/shared/realms';
import { heroAdventureLine, realmsAway, realmsInjured, realmsList } from './page';

export const views = [
	defineClientView({
		id: 'realms.list',
		needs: ['realms.overview'],
		compute: (get) => realmsList(get.data<RealmsOverview>('realms.overview'), get.params),
	}),
	defineClientView({
		id: 'realms.away',
		needs: ['realms.overview'],
		compute: (get) => realmsAway(get.data<RealmsOverview>('realms.overview')),
	}),
	defineClientView({
		id: 'realms.injured',
		needs: ['realms.overview'],
		compute: (get) => realmsInjured(get.data<RealmsOverview>('realms.overview'), get.static<RealmsCatalog>('realms.catalog')),
	}),
];

export const parts = [
	// On hero cards: its adventure numbers, from what the realms plugin attaches to each hero.
	defineClientPart<HeroCardPart>({ point: 'heroes.card', id: 'realms', part: (data) => [heroAdventureLine(data as AdventureStats)] }),
];
