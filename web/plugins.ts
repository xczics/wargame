// Client plugin manifest — the browser-side counterpart of src/plugins.ts.
// `auth` comes first: when logged out it gates the UI before the game plugins are set up.
import type { ClientPlugin } from './core/game';
import armies from './plugins/armies';
import auth from './plugins/auth';
import battle from './plugins/battle';
import city from './plugins/city';
import equipment from './plugins/equipment';
import forms from './plugins/forms';
import gmPanel from './plugins/gm-panel';
import heroes from './plugins/heroes';
import inventory from './plugins/inventory';
import localeZh from './plugins/locale-zh';
import mail from './plugins/mail';
import realms from './plugins/realms';
import research from './plugins/research';
import resourceBar from './plugins/resource-bar';
import settlement from './plugins/settlement';
import shop from './plugins/shop';
import siege from './plugins/siege';
import troops from './plugins/troops';
import warReports from './plugins/war-reports';
import worldMap from './plugins/world-map';

export const plugins: ClientPlugin[] = [
	localeZh,
	auth,
	forms,
	settlement,
	resourceBar,
	city,
	research,
	heroes,
	equipment,
	troops,
	inventory,
	shop,
	armies,
	battle,
	siege,
	mail,
	realms,
	warReports,
	worldMap,
	gmPanel,
];
