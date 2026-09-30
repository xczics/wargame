// Client plugin manifest — the browser-side counterpart of src/plugins.ts.
// `auth` comes first: when logged out it gates the UI before the game plugins are set up.
import type { ClientPlugin } from './core/game';
import armies from './plugins/armies';
import auth from './plugins/auth';
import city from './plugins/city';
import forms from './plugins/forms';
import gmPanel from './plugins/gm-panel';
import inventory from './plugins/inventory';
import localeZh from './plugins/locale-zh';
import research from './plugins/research';
import resourceBar from './plugins/resource-bar';
import settlement from './plugins/settlement';
import troops from './plugins/troops';
import worldMap from './plugins/world-map';

export const plugins: ClientPlugin[] = [
	localeZh,
	auth,
	forms,
	settlement,
	resourceBar,
	city,
	research,
	troops,
	inventory,
	armies,
	worldMap,
	gmPanel,
];
