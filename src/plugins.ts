/**
 * The plugin manifest: the single place that decides what the game is made of.
 * Order does not matter (the kernel sorts by `dependsOn`); removing a line disables
 * a plugin. See AGENTS.md "Plugin architecture" before adding one.
 *
 * Third-party plugins need no line here: every `extensions/<id>/server.ts` is found at build time
 * (docs/plugin-guide.md, "扩展").
 */
import type { Plugin } from './kernel';
import accounts from './plugins/accounts';
import armies from './plugins/armies';
import bandits from './plugins/bandits';
import battle from './plugins/battle';
import buildings from './plugins/buildings';
import equipment from './plugins/equipment';
import forms from './plugins/forms';
import gm from './plugins/gm';
import heroes from './plugins/heroes';
import i18n from './plugins/i18n';
import httpApi from './plugins/http-api';
import invites from './plugins/invites';
import items from './plugins/items';
import loot from './plugins/loot';
import mail from './plugins/mail';
import npcCamps from './plugins/npc-camps';
import playerSettlements from './plugins/player-settlements';
import prestige from './plugins/prestige';
import pvp from './plugins/pvp';
import realms from './plugins/realms';
import research from './plugins/research';
import resources from './plugins/resources';
import settlements from './plugins/settlements';
import shop from './plugins/shop';
import settling from './plugins/settling';
import starterArmy from './plugins/starter-army';
import starterAuxiliary from './plugins/starter-auxiliary';
import starterBandits from './plugins/starter-bandits';
import starterContent from './plugins/starter-content';
import starterDefense from './plugins/starter-defense';
import starterEquipment from './plugins/starter-equipment';
import starterHeroes from './plugins/starter-heroes';
import starterItems from './plugins/starter-items';
import starterLevies from './plugins/starter-levies';
import starterPrestige from './plugins/starter-prestige';
import starterRealms from './plugins/starter-realms';
import starterResearch from './plugins/starter-research';
import starterShop from './plugins/starter-shop';
import starterSiege from './plugins/starter-siege';
import stats from './plugins/stats';
import terrain from './plugins/terrain';
import timeline from './plugins/timeline';
import ui from './plugins/ui';
import queues from './plugins/queues';
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
	ui,
	i18n,
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
	loot,
	queues,
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
	prestige,
	bandits,
	// content
	playerSettlements,
	starterContent,
	starterArmy,
	starterAuxiliary,
	starterBandits,
	starterDefense,
	starterHeroes,
	starterPrestige,
	starterResearch,
	starterItems,
	starterLevies,
	starterRealms,
	starterEquipment,
	starterShop,
	starterSiege,
	npcCamps,
	warReports,
	// extensions
	...Object.values(import.meta.glob<{ default: Plugin }>('../extensions/*/server.ts', { eager: true })).map((m) => m.default),
];
