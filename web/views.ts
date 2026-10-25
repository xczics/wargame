// Every view assembled in the browser, by client plugin: registered by their plugins, and run by the tests on the data
// views the engine works out (test/helpers.ts).
import type { ClientPartDef, ClientViewDef } from '../src/shared/client-views';
import { formParts as pvpForms } from './plugins/pvp/forms';
import { formParts as starterLeviesForms } from './plugins/starter-levies/forms';
import { formParts as starterRealmsForms } from './plugins/starter-realms/forms';
import { parts as starterRealmsParts } from './plugins/starter-realms/parts';
import { formParts as settlingForms } from './plugins/settling/forms';
import { formParts as shopForms } from './plugins/shop/forms';
import { formParts as heroesForms } from './plugins/heroes/forms';
import { formParts as researchForms } from './plugins/research/forms';
import { formParts as buildingsForms } from './plugins/buildings/forms';
import { formParts as realmsForms } from './plugins/realms/forms';
import { formParts as settlementForms } from './plugins/settlement/forms';
import { formParts as armiesForms } from './plugins/armies/forms';
import { views as armies } from './plugins/armies/views';
import { views as bandits } from './plugins/bandits/views';
import { views as buildings } from './plugins/buildings/views';
import { mapPart as npcCampsMap, nearbyPart as npcCampsNearby } from './plugins/npc-camps/map';
import { mapPart as terrainMap } from './plugins/terrain/map';
import { parts as equipmentParts, views as equipment } from './plugins/equipment/views';
import { views as forms } from './plugins/forms/views';
import { views as heroes } from './plugins/heroes/views';
import { formParts as itemsForms } from './plugins/items/forms';
import { views as items } from './plugins/items/views';
import { parts as mailParts, views as mail } from './plugins/mail/views';
import { parts as opaqueResearchParts } from './plugins/opaque-research/effects';
import { views as prestige } from './plugins/prestige/views';
import { parts as realmsParts, views as realms } from './plugins/realms/views';
import { parts as warReportsParts } from './plugins/war-reports/views';
import { parts as starterRewardsParts } from './plugins/starter-rewards/describe';
import { parts as rewardsParts } from './plugins/rewards/describe';
import { views as research } from './plugins/research/views';
import { views as resources } from './plugins/resource-bar/views';
import { views as settlements } from './plugins/settlement/views';
import { mapPart as settlementsMap } from './plugins/settlement/map';
import { views as shop } from './plugins/shop/views';
import { parts as starterArmyParts } from './plugins/starter-army/effects';
import { parts as starterDefenseParts } from './plugins/starter-defense/effects';
import { parts as starterEquipmentParts } from './plugins/starter-equipment/parts';
import { views as starterEquipment } from './plugins/starter-equipment/views';
import { parts as starterHeroesParts, views as starterHeroes } from './plugins/starter-heroes/views';
import { formParts as starterItemsForms } from './plugins/starter-items/forms';
import { parts as starterSiegeParts } from './plugins/starter-siege/effects';
import { views as starterSiege } from './plugins/starter-siege/views';
import { formParts as troopsForms } from './plugins/troops/forms';
import { views as troops } from './plugins/troops/views';
import { views as worldMap } from './plugins/world-map/views';

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
	...worldMap,
];

// What client plugins add at other client plugins' extension points (`defineClientPart`), in the order they register.
export const clientParts: ClientPartDef[] = [
	// Hero cards ("heroes.card", "heroes.attributes") and their adventure numbers ("realms.heroStats").
	...realmsParts,
	// Mails as reports ("mail.report", by kind).
	...mailParts,
	...warReportsParts,
	// Rewards in words ("rewards.describe", by kind).
	...starterRewardsParts,
	...rewardsParts,
	...starterHeroesParts,
	...equipmentParts,
	...starterRealmsParts,
	...starterEquipmentParts,
	settlementsMap,
	// The nearby list ("settlements.nearby").
	npcCampsNearby as ClientPartDef,
	npcCampsMap,
	terrainMap,
	// Building cards ("buildings.effects"): words for the numbers their server plugins give.
	...starterDefenseParts,
	...starterSiegeParts,
	...starterArmyParts,
	...opaqueResearchParts,
	// Forms ("forms.prepare"): words for the data their commands' `prepare` sends, by part id (src/shared/forms.ts).
	...troopsForms,
	...armiesForms,
	...itemsForms,
	...starterItemsForms,
	...settlementForms,
	...realmsForms,
	...buildingsForms,
	...researchForms,
	...heroesForms,
	...shopForms,
	...settlingForms,
	...starterRealmsForms,
	...starterLeviesForms,
	...pvpForms,
];
