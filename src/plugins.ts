/**
 * The plugin manifest: the single place that decides what the game is made of.
 * Order does not matter (the kernel sorts by `dependsOn`); removing a line disables
 * a plugin. See AGENTS.md "Plugin architecture" before adding one.
 */
import type { Plugin } from './kernel';
import accounts from './plugins/accounts';
import armies from './plugins/armies';
import buildings from './plugins/buildings';
import forms from './plugins/forms';
import gm from './plugins/gm';
import httpApi from './plugins/http-api';
import invites from './plugins/invites';
import items from './plugins/items';
import npcCamps from './plugins/npc-camps';
import playerSettlements from './plugins/player-settlements';
import pvp from './plugins/pvp';
import research from './plugins/research';
import resources from './plugins/resources';
import settlements from './plugins/settlements';
import starterContent from './plugins/starter-content';
import starterItems from './plugins/starter-items';
import starterResearch from './plugins/starter-research';
import stats from './plugins/stats';
import timeline from './plugins/timeline';
import troops from './plugins/troops';
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
	research,
	items,
	troops,
	armies,
	pvp,
	// content
	playerSettlements,
	starterContent,
	starterResearch,
	starterItems,
	npcCamps,
];
