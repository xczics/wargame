// Every view assembled in the browser, by client plugin: registered by their plugins, and run by the tests on the data
// views the engine works out (test/helpers.ts).
import type { ClientPartDef, ClientViewDef } from '../src/shared/client-views';
import { views as armies } from './plugins/armies/views';
import { views as bandits } from './plugins/bandits/views';
import { views as buildings } from './plugins/buildings/views';
import { views as equipment } from './plugins/equipment/views';
import { views as forms } from './plugins/forms/views';
import { views as heroes } from './plugins/heroes/views';
import { views as items } from './plugins/items/views';
import { views as mail } from './plugins/mail/views';
import { views as prestige } from './plugins/prestige/views';
import { parts as realmsParts, views as realms } from './plugins/realms/views';
import { views as research } from './plugins/research/views';
import { views as resources } from './plugins/resource-bar/views';
import { views as settlements } from './plugins/settlement/views';
import { views as shop } from './plugins/shop/views';
import { views as starterEquipment } from './plugins/starter-equipment/views';
import { parts as starterHeroesParts, views as starterHeroes } from './plugins/starter-heroes/views';
import { views as starterSiege } from './plugins/starter-siege/views';
import { views as troops } from './plugins/troops/views';

export const clientViews: ClientViewDef[] = [
	...armies,
	...bandits,
	...buildings,
	...equipment,
	...forms,
	...heroes,
	...items,
	...mail,
	...prestige,
	...realms,
	...research,
	...resources,
	...settlements,
	...shop,
	...starterEquipment,
	...starterHeroes,
	...starterSiege,
	...troops,
];

// What client plugins add at other client plugins' extension points (`defineClientPart`), in the order they register.
export const clientParts: ClientPartDef[] = [...realmsParts, ...starterHeroesParts];
