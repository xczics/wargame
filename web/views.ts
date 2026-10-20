// Every view assembled in the browser, by client plugin: registered by their plugins, and run by the tests on the data
// views the engine works out (test/helpers.ts).
import type { ClientViewDef } from '../src/shared/client-views';
import { views as buildings } from './plugins/buildings/views';
import { views as realms } from './plugins/realms/views';
import { views as starterEquipment } from './plugins/starter-equipment/views';

export const clientViews: ClientViewDef[] = [...buildings, ...realms, ...starterEquipment];
