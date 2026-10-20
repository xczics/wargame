// NPC camps on the world map (client layer "npc-camps", for the data of the server's map layer of that id): a camp's
// tile tells what to expect, its level, roughly how many defend it and how strong its stockade and heroes are, and what
// a victory brings. What a level means is the static view `npc-camps.levels` (rules-made); the window only says each
// camp's kind, level and how full it is. Pure: the tests run it.
import type { MapWindowCamps, NpcCampLevels } from '../../../src/shared/api';
import { amount, duration } from '../../../src/shared/format';
import { uiTexts } from '../../../src/shared/i18n';
import type { GridCell, UiLine } from '../../../src/shared/ui';
import { defineClientPart } from '../../../src/shared/client-views';
import type { MapLayer } from '../world-map/views';

// The npc-camps plugin's own words (its i18n keys).
const text = uiTexts('npc-camps');

const layer: MapLayer<MapWindowCamps> = {
	order: 20,
	cells(data, window, get) {
		const levels = get.static<NpcCampLevels>('npc-camps.levels');
		const out = new Map<string, Partial<GridCell>>();
		if (!levels) return out;
		for (const [key, entity] of Object.entries(window.held)) {
			if (!entity.startsWith('settlement:')) continue;
			const camp = data[entity.slice('settlement:'.length)];
			const row = camp && levels[camp.kind]?.[camp.level];
			if (!camp || !row) continue;
			const info: UiLine[] = [
				{ text: text('Level {0}', { 0: camp.level }) },
				// "Defenders: about 4,000 in all, up to tier 2, 1 leaders" / "..., leaderless".
				{
					text: row.heroes
						? text('Defenders: about {0} in all, up to tier {1}, {2} leaders', { 0: amount(row.defenders), 1: row.tier, 2: row.heroes })
						: text('Defenders: about {0} in all, up to tier {1}, leaderless', { 0: amount(row.defenders), 1: row.tier }),
				},
				{ text: text('Stockade: defence +{0} in every lane', { 0: amount(row.stockade) }), tone: 'muted' },
				row.takes === 'resources'
					? {
							text: text('Victory: up to {0} resources (as much as your survivors carry)', {
								0: amount(Math.floor((row.loot.total ?? 0) * camp.share)),
							}),
							tone: 'info',
						}
					: {
							text: text('Victory: captures {0}', {
								0: Object.entries(row.loot)
									.filter(([, n]) => n > 0)
									.map(([tier, n]) => text('tier {0} ×{1}', { 0: tier, 1: amount(Math.floor(n * camp.share)) })),
							}),
							tone: 'info',
						},
				...(camp.fullAt !== undefined
					? [
							{
								text: text('Recently beaten: full again in {0}', { 0: duration((camp.fullAt - window.now) / 1000) }),
								tone: 'muted' as const,
							},
						]
					: []),
			];
			out.set(key, { info });
		}
		return out;
	},
};

// At the world map's extension point, for the data of the server plugin "npc-camps".
export const mapPart = defineClientPart<MapLayer>({ point: 'world-map.layer', id: 'npc-camps', part: layer as MapLayer });
