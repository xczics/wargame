// Every view assembled in the browser, by client plugin: registered by their plugins, and run by the tests on the data
// views the engine works out (test/helpers.ts).
import type { ClientViewDef } from '../src/shared/client-views';
import { views as buildings } from './plugins/buildings/views';
import { views as mail } from './plugins/mail/views';
import { views as prestige } from './plugins/prestige/views';
import { views as resources } from './plugins/resource-bar/views';
import { views as settlements } from './plugins/settlement/views';
import { views as starterHeroes } from './plugins/starter-heroes/views';
import { views as starterSiege } from './plugins/starter-siege/views';
import { views as troops } from './plugins/troops/views';

export const clientViews: ClientViewDef[] = [
	...buildings,
	...resources,
	...settlements,
	...starterHeroes,
	...starterSiege,
	...troops,
	...prestige,
	...mail,
];
