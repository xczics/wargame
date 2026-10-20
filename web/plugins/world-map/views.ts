// The map's grid (`world-map.grid`, generic widget `ui.grid`), assembled in the browser (AGENTS.md: the server sends data
// only) from the window's data (`world-map.window`): who holds which tile, and each layer's data about them. What a
// tile shows is drawn by the client part at "world-map.layer" (`defineClientPart`) of the server plugin that sent that
// data (its id: the server layer's), so this plugin knows nothing of settlements or camps. Pure: the tests run it.
import type { MapWindow, MapWindowMarkers } from '../../../src/shared/api';
import { type ClientViewGet, defineClientView } from '../../../src/shared/client-views';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import type { GridCell, GridData, GridSide, UiLine, UiText } from '../../../src/shared/ui';

// The world-map plugin's own words (its i18n keys).
const text = uiTexts('world-map');

/**
 * Extension point "world-map.layer": a client part (`defineClientPart({ point: 'world-map.layer', id, part })`) draws
 * the data the server layer of the same id sent (`MapWindow.layers[id]`, `MapWindow.sides[id]`). Layers merge by
 * `order` (the last fill / icon / tone wins; tooltips, info and buttons add up).
 */
export const MAP_LAYER = 'world-map.layer';
export interface MapLayer<L = unknown, S = unknown> {
	order: number;
	/** What the tiles show, by tile key ("x,y"); `window.held` says who holds each. */
	cells?(data: L, window: MapWindow, get: ClientViewGet): Map<string, Partial<GridCell>>;
	/** A list beside the grid. */
	side?(data: S, window: MapWindow, get: ClientViewGet): GridSide | null;
	/** What the layer's fills mean. */
	legend?(get: ClientViewGet): { fill: string; label: UiText }[];
}

/** Tiles held by marked entities (`worldMap.addMarkers`, e.g. realms). */
const markerLayer: MapLayer<MapWindowMarkers> = {
	order: 100,
	cells(data, window) {
		const out = new Map<string, Partial<GridCell>>();
		for (const [key, entity] of Object.entries(window.held)) {
			const m = data[entity];
			if (m)
				out.set(key, {
					icon: m.icon,
					tone: 'marked',
					title: [keyText(m.name)],
					info: [{ text: text('{icon} {name}', { icon: m.icon, name: keyText(m.name) }) }],
				});
		}
		return out;
	},
};

export const views = [
	defineClientView<GridData>({
		id: 'world-map.grid',
		needs: ['world-map.window'],
		compute(get) {
			const w = get.data<MapWindow>('world-map.window');
			const bounds = get.meta<{ min: number; max: number }>('map');
			if (!w || !bounds) return undefined;
			const ordered = [['markers', markerLayer as MapLayer] as const, ...get.parts<MapLayer>(MAP_LAYER)]
				.map(([id, layer]) => ({ id, ...layer }))
				.sort((a, b) => a.order - b.order);
			const cells = new Map<string, GridCell>();
			for (const layer of ordered) {
				const data = w.layers[layer.id];
				if (data === undefined || !layer.cells) continue;
				for (const [key, part] of layer.cells(data, w, get)) {
					let c = cells.get(key);
					if (!c) {
						const [x, y] = key.split(',').map(Number);
						cells.set(key, (c = { x, y }));
					}
					const { title, info, actions, ...rest } = part;
					Object.assign(c, rest);
					if (title) c.title = [...(c.title ?? []), ...title];
					if (info) c.info = [...(c.info ?? []), ...info];
					if (actions) c.actions = [...(c.actions ?? []), ...actions];
				}
			}
			const free: UiLine = { text: text('Free land.'), tone: 'muted' };
			for (const c of cells.values()) if (!c.tone) c.info = [...(c.info ?? []), free];
			const sides: GridSide[] = [];
			for (const layer of ordered) {
				const data = w.sides[layer.id];
				const side = data !== undefined && layer.side?.(data, w, get);
				if (side) sides.push(side);
			}
			return {
				title: text('Map'),
				minX: bounds.min,
				minY: bounds.min,
				width: bounds.max - bounds.min + 1,
				height: bounds.max - bounds.min + 1,
				wrap: true,
				centre: w.centre,
				radius: w.radius,
				...(w.home ? { home: w.home } : {}),
				cells: [...cells.values()],
				...(w.ground ? { ground: w.ground } : {}),
				emptyInfo: [free],
				legend: ordered.flatMap((l) => l.legend?.(get) ?? []),
				placement: 'tile',
				sides,
			};
		},
	}),
];
