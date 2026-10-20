// The realms plugin's views assembled in the browser (src/shared/client-views.ts): the player's part
// (`realms.overview`) put together with the static `realms.tasks` (`realmsInfo`), then laid out (./page.ts).
import type { HeroCardPart, RealmsCatalog, RealmsOverview, RealmsStatic } from '../../../src/shared/api';
import { defineClientPart, defineClientView, type ClientViewDef } from '../../../src/shared/client-views';
import { realmsInfo, type AdventureStats } from '../../../src/shared/realms';
import { heroAdventureLine, realmsAway, realmsInjured, realmsList } from './page';

type Get = Parameters<ClientViewDef['compute']>[0];
const info = (get: Get) => realmsInfo(get.data<RealmsOverview>('realms.overview'), get.static<RealmsStatic>('realms.tasks')) ?? undefined;

export const views = [
	defineClientView({ id: 'realms.info', needs: ['realms.overview'], compute: (get) => info(get) ?? null }),
	defineClientView({
		id: 'realms.list',
		needs: ['realms.overview'],
		compute: (get) => realmsList(info(get), get.params),
	}),
	defineClientView({
		id: 'realms.away',
		needs: ['realms.overview'],
		compute: (get) => realmsAway(info(get)),
	}),
	defineClientView({
		id: 'realms.injured',
		needs: ['realms.overview'],
		compute: (get) => realmsInjured(info(get), get.static<RealmsCatalog>('realms.catalog')),
	}),
];

export const parts = [
	// On hero cards: its adventure numbers, from what the realms plugin attaches to each hero.
	defineClientPart<HeroCardPart>({ point: 'heroes.card', id: 'realms', part: (data) => [heroAdventureLine(data as AdventureStats)] }),
];
