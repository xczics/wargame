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
import opaqueResearch from './plugins/opaque-research';
import personalization from './plugins/personalization';
import prestige from './plugins/prestige';
import puzzles from './plugins/puzzles';
import realms from './plugins/realms';
import resourceBar from './plugins/resource-bar';
import settlement from './plugins/settlement';
import starterEquipment from './plugins/starter-equipment';
import starterHeroes from './plugins/starter-heroes';
import starterSiege from './plugins/starter-siege';
import troops from './plugins/troops';
import research from './plugins/research';
import shop from './plugins/shop';
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
	mail,
	prestige,
	starterHeroes,
	starterSiege,
	widgets,
	puzzles,
	opaqueResearch,
	assistant,
	gmPanel,
	// Third-party client plugins: every extensions/<id>/client.ts, found at build time.
	...Object.values(import.meta.glob<{ default: ClientPlugin }>('../extensions/*/client.ts', { eager: true })).map((m) => m.default),
];
