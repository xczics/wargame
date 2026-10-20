// Every view assembled in the browser, by client plugin: registered by their plugins, and run by the tests on the data
// views the engine works out (test/helpers.ts).
import type { ClientViewDef } from '../src/shared/client-views';
import { views as armies } from './plugins/armies/views';
import { views as bandits } from './plugins/bandits/views';
import { views as buildings } from './plugins/buildings/views';
import { views as equipment } from './plugins/equipment/views';
import { views as forms } from './plugins/forms/views';
import { views as heroes } from './plugins/heroes/views';
import { views as realms } from './plugins/realms/views';
import { views as starterEquipment } from './plugins/starter-equipment/views';
import { views as troops } from './plugins/troops/views';

export const clientViews: ClientViewDef[] = [
	...armies,
	...bandits,
	...buildings,
	...equipment,
	...forms,
	...heroes,
	...realms,
	...starterEquipment,
	...troops,
];
