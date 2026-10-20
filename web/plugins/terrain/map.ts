// Terrain on the world map (client layer "terrain", for the data of the server's map layer of that id): what a tile's
// ground gives outer cities and resource fortresses built on it. Pure: the tests run it.
import type { MapWindowTerrain, ResourceMeta } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { resourceIcons, signed } from '../../../src/shared/format';
import { uiTexts } from '../../../src/shared/i18n';
import type { UiLine } from '../../../src/shared/ui';
import type { MapLayer } from '../world-map/views';

// The terrain plugin's own words (its i18n keys).
const text = uiTexts('terrain');

const layer: MapLayer<MapWindowTerrain> = {
	order: 0,
	ground(data, get) {
		const icons = resourceIcons(get.meta<ResourceMeta[]>('resources') ?? []);
		const out: Record<string, UiLine[]> = {};
		for (const t of get.meta<{ code: string }[]>('terrains') ?? []) {
			const parts = Object.entries(data.bonus[t.code] ?? {}).map(([r, pct]) =>
				text('{0}{1}', { 0: icons[r] ?? r, 1: signed(pct, true, 0) }),
			);
			out[t.code] = [
				parts.length
					? { text: text('Outer cities and resource fortresses here: {0}', { 0: parts }), tone: 'info' }
					: { text: text('No production bonus here'), tone: 'muted' },
			];
		}
		return out;
	},
};

// At the world map's extension point, for the data of the server plugin "terrain".
export const mapPart = defineClientPart<MapLayer>({ point: 'world-map.layer', id: 'terrain', part: layer as MapLayer });
