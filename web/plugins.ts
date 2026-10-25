// Client plugin manifest — the browser-side counterpart of src/plugins.ts.
// `auth` comes first (after `personalization`, which only dresses the page): when logged out it gates the UI before the game plugins are set up.
import type { ClientPlugin } from './core/game';
import armies from './plugins/armies';
import assistant from './plugins/assistant';
import auth from './plugins/auth';
import bandits from './plugins/bandits';
import buildings from './plugins/buildings';
import equipment from './plugins/equipment';
import forms from './plugins/forms';
import gmPanel from './plugins/gm-panel';
import heroes from './plugins/heroes';
import items from './plugins/items';
import mail from './plugins/mail';
import npcCamps from './plugins/npc-camps';
import terrain from './plugins/terrain';
import opaqueResearch from './plugins/opaque-research';
import personalization from './plugins/personalization';
import prestige from './plugins/prestige';
import pvp from './plugins/pvp';
import puzzles from './plugins/puzzles';
import realms from './plugins/realms';
import warReports from './plugins/war-reports';
import starterRewards from './plugins/starter-rewards';
import rewards from './plugins/rewards';
import resourceBar from './plugins/resource-bar';
import settlement from './plugins/settlement';
import settling from './plugins/settling';
import starterEquipment from './plugins/starter-equipment';
import starterHeroes from './plugins/starter-heroes';
import starterItems from './plugins/starter-items';
import starterLevies from './plugins/starter-levies';
import starterRealms from './plugins/starter-realms';
import starterSiege from './plugins/starter-siege';
import troops from './plugins/troops';
import research from './plugins/research';
import shop from './plugins/shop';
import starterArmy from './plugins/starter-army';
import starterDefense from './plugins/starter-defense';
import widgets from './plugins/widgets';
import worldMap from './plugins/world-map';

export const plugins: ClientPlugin[] = [
	// Before auth: the site's icon and title also on the login screen.
	personalization,
	auth,
	forms,
	worldMap,
	settlement,
	npcCamps,
	terrain,
	resourceBar,
	buildings,
	realms,
	starterEquipment,
	heroes,
	equipment,
	troops,
	armies,
	bandits,
	research,
	items,
	shop,
	// Words for what their server plugins give buildings (a wall's defence...), at buildings' extension point "buildings.effects".
	starterDefense,
	starterArmy,
	mail,
	warReports,
	starterRewards,
	rewards,
	prestige,
	starterHeroes,
	starterSiege,
	// Words for the data their server plugins' forms send ("forms.prepare").
	starterItems,
	starterLevies,
	starterRealms,
	settling,
	pvp,
	widgets,
	puzzles,
	opaqueResearch,
	assistant,
	gmPanel,
	// Third-party client plugins: every extensions/<id>/client.ts, found at build time.
	...Object.values(import.meta.glob<{ default: ClientPlugin }>('../extensions/*/client.ts', { eager: true })).map((m) => m.default),
];
