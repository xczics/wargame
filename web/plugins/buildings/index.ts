// The City page's building cards at any level: built in the browser from the static data of `buildings.catalog`
// (tables and rules) by the same functions the server quotes with (src/shared/buildings.ts); the player's view only
// says which building and level each slot has.
import { buildingTemplate } from '../../../src/shared/buildings';
import { defineTemplates } from '../../../src/shared/statics';
import { defineClientPlugin } from '../../core/game';

export default defineClientPlugin({
	id: 'buildings',
	setup() {
		defineTemplates('buildings', buildingTemplate);
	},
});
