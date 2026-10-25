// The realms plugin's views assembled in the browser (src/shared/client-views.ts): the player's part
// (`realms.overview`) put together with the static `realms.tasks` (`realmsInfo`), then laid out (./page.ts).
import type { HeroCardPart, MailReportPart, RealmsCatalog, RealmsOverview, RealmsStatic } from '../../../src/shared/api';
import { defineClientPart, defineClientView, type ClientViewDef } from '../../../src/shared/client-views';
import { ADVENTURE_POINTS, adventureTotal, realmsInfoOf, type AdventureCardData, type HeroStatsPart } from '../../../src/shared/realms';
import { heroAdventureLine, realmsAway, realmsInjured, realmsList } from './page';
import { adventureReport } from './report';

type Get = Parameters<ClientViewDef['compute']>[0];
const info = (get: Get) =>
	realmsInfoOf(get.data<RealmsOverview>('realms.overview'), get.static<RealmsStatic>('realms.tasks'), get) ?? undefined;

export const views = [
	defineClientView({ id: 'realms.info', needs: ['realms.overview'], points: ADVENTURE_POINTS, compute: (get) => info(get) ?? null }),
	defineClientView({
		id: 'realms.list',
		needs: ['realms.overview'],
		points: ADVENTURE_POINTS,
		compute: (get) => realmsList(info(get), get.params),
	}),
	defineClientView({
		id: 'realms.away',
		needs: ['realms.overview'],
		points: ADVENTURE_POINTS,
		compute: (get) => realmsAway(info(get)),
	}),
	defineClientView({
		id: 'realms.injured',
		needs: ['realms.overview'],
		points: ADVENTURE_POINTS,
		compute: (get) => realmsInjured(info(get), get.static<RealmsCatalog>('realms.catalog')),
	}),
];

export const parts = [
	// The adventure report in the mailbox.
	defineClientPart<MailReportPart>({ point: 'mail.report', id: 'realms.report', part: (message) => adventureReport(message) }),
	// On hero cards: its adventure numbers, the shares other client plugins add ("realms.heroStats": attributes, gear) and
	// recovery from research (what the realms plugin attaches), kept in range as the fights have them.
	defineClientPart<HeroCardPart>({
		point: 'heroes.card',
		id: 'realms',
		points: ['realms.heroStats'],
		part: (data, hero, get) => [
			heroAdventureLine(
				adventureTotal([
					...[...get.parts<HeroStatsPart>('realms.heroStats').values()].map((share) => share(hero, get)),
					{ recovery: (data as AdventureCardData | undefined)?.recovery ?? 0 },
				]),
			),
		],
	}),
];
