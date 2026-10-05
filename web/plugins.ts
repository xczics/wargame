// Client plugin manifest — the browser-side counterpart of src/plugins.ts.
// `auth` comes first: when logged out it gates the UI before the game plugins are set up.
import type { ClientPlugin } from './core/game';
import auth from './plugins/auth';
import buildings from './plugins/buildings';
import forms from './plugins/forms';
import gmPanel from './plugins/gm-panel';
import mail from './plugins/mail';
import resourceBar from './plugins/resource-bar';
import settlement from './plugins/settlement';
import widgets from './plugins/widgets';

export const plugins: ClientPlugin[] = [
	auth,
	forms,
	settlement,
	resourceBar,
	buildings,
	mail,
	widgets,
	gmPanel,
	// Third-party client plugins: every extensions/<id>/client.ts, found at build time.
	...Object.values(import.meta.glob<{ default: ClientPlugin }>('../extensions/*/client.ts', { eager: true })).map((m) => m.default),
];
