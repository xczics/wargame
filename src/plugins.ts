/**
 * The plugin manifest: the single place that decides what the game is made of.
 * Order does not matter (the kernel sorts by `dependsOn`); removing a line disables
 * a plugin. See AGENTS.md "Plugin architecture" before adding one.
 */
import type { Plugin } from './kernel';
import accounts from './plugins/accounts';
import armies from './plugins/armies';
import battle from './plugins/battle';
import buildings from './plugins/buildings';
import equipment from './plugins/equipment';
import forms from './plugins/forms';
import gm from './plugins/gm';
import heroes from './plugins/heroes';
import httpApi from './plugins/http-api';
import invites from './plugins/invites';
import items from './plugins/items';
import mail from './plugins/mail';
import npcCamps from './plugins/npc-camps';
import playerSettlements from './plugins/player-settlements';
import pvp from './plugins/pvp';
import realms from './plugins/realms';
import research from './plugins/research';
import resources from './plugins/resources';
import settlements from './plugins/settlements';
import shop from './plugins/shop';
import settling from './plugins/settling';
import starterArmy from './plugins/starter-army';
import starterAuxiliary from './plugins/starter-auxiliary';
import starterContent from './plugins/starter-content';
import starterDefense from './plugins/starter-defense';
import starterEquipment from './plugins/starter-equipment';
import starterHeroes from './plugins/starter-heroes';
import starterItems from './plugins/starter-items';
import starterRealms from './plugins/starter-realms';
import starterResearch from './plugins/starter-research';
import starterShop from './plugins/starter-shop';
import starterSiege from './plugins/starter-siege';
import stats from './plugins/stats';
import terrain from './plugins/terrain';
import timeline from './plugins/timeline';
import troops from './plugins/troops';
import warReports from './plugins/war-reports';
import worldMap from './plugins/world-map';

export const plugins: Plugin[] = [
	// platform
	accounts,
	invites,
	gm,
	httpApi,
	forms,
	// game systems
	stats,
	timeline,
	worldMap,
	resources,
	settlements,
	buildings,
	terrain,
	research,
	items,
	troops,
	armies,
	settling,
	battle,
	pvp,
	heroes,
	mail,
	realms,
	equipment,
	shop,
	// content
	playerSettlements,
	starterContent,
	starterArmy,
	starterAuxiliary,
	starterDefense,
	starterHeroes,
	starterResearch,
	starterItems,
	starterRealms,
	starterEquipment,
	starterShop,
	starterSiege,
	npcCamps,
	warReports,
];
