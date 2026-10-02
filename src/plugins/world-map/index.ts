/**
 * World map: a 1024 x 1024 grid whose edges wrap on both axes (x and y run from -511 to
 * +512; -511 and +512 are neighbours). Topologically a torus: walking off one edge brings
 * you back on the opposite one.
 *
 * Only occupied tiles are stored (`world_map_tiles`, primary key (x, y)), so two
 * commands racing for the same tile cannot both succeed: the second batch fails on the
 * key and nothing of it is written.
 */
import { definePlugin, GameError, PluginError, type EngineApi, type ReadApi, type ViewParams } from '../../kernel';
import type { MapMarker } from '../../shared/api';
import type { GridCell, GridData, GridSide, UiText } from '../../shared/ui';
import i18nCsv from './data/i18n.csv?raw';

export const MAP_MIN = -511;
export const MAP_MAX = 512;
export const MAP_SIZE = MAP_MAX - MAP_MIN + 1;

export interface Tile {
	x: number;
	y: number;
}

/** Bring any integer coordinate back onto the map. */
export const wrap = (v: number) => ((((v - MAP_MIN) % MAP_SIZE) + MAP_SIZE) % MAP_SIZE) + MAP_MIN;
/** Shortest signed offset from a to b along one axis (in -511..512). */
export const delta = (a: number, b: number) => wrap(b - a);
export const tileKey = (t: Tile) => `${t.x},${t.y}`;

export interface WorldMapService {
	wrap: typeof wrap;
	/** Euclidean distance using the shortest way around. */
	distance(a: Tile, b: Tile): number;
	/** Chessboard distance (max of |dx|, |dy|) using the shortest way around. */
	ring(a: Tile, b: Tile): number;
	/** Every tile within `radius` rings of `centre` (a (2r+1)^2 square), wrapped. */
	square(centre: Tile, radius: number): Tile[];
	/** Occupant entity by tile key, for the given tiles only. */
	occupants(api: ReadApi, tiles: Tile[]): Promise<Map<string, string>>;
	/** Occupied tiles in the square window around `centre`. */
	window(api: ReadApi, centre: Tile, radius: number): Promise<(Tile & { entity: string })[]>;
	/** Queue the claim of free tiles for `entity`. Throws if any is taken. */
	claim(api: EngineApi, tiles: Tile[], entity: string): Promise<void>;
	/** Queue releasing every tile of `entity`. */
	release(api: EngineApi, entity: string): void;
	/** A random centre whose whole (2r+1)^2 square is free, or null after `attempts` tries. */
	findFreeSquare(api: ReadApi, radius: number, attempts?: number): Promise<Tile | null>;
	/**
	 * Show tiles held by entities "<prefix>:<id>" on the map (view `world-map.markers`), e.g. realms.
	 * `describe` gets the ids found in the window and returns what to show for each (missing = not shown).
	 */
	addMarkers(prefix: string, describe: (api: ReadApi, ids: string[]) => Promise<Map<string, Omit<MapMarker, 'x' | 'y'>>>): void;
	/**
	 * Draw on the map (view `world-map.grid`, generic widget `ui.grid`): for the tiles of a window, what
	 * each shows — fill, icon, border, tooltip, info and buttons when selected — by tile key ("x,y").
	 * Layers merge in order (the last fill / icon / tone wins; tooltips, info and buttons add up).
	 * `legend`: what the layer's fills mean. Must only read.
	 */
	/** A list beside the map's grid for the window around `centre` (e.g. NPC settlements nearby); `params` are the request's. */
	addSide(side: (api: ReadApi, centre: Tile, params: ViewParams) => Promise<GridSide | null>): void;
	addLayer(
		layer: (api: ReadApi, tiles: Tile[]) => Promise<Map<string, Partial<GridCell>>>,
		legend?: () => { fill: string; label: UiText }[],
	): void;
	/** Where the map's "home" button goes for the acting player (e.g. the selected settlement). */
	setHome(home: (api: ReadApi, params: Record<string, string>) => Promise<Tile | null>): void;
}

declare module '../../kernel' {
	interface ServiceMap {
		worldMap: WorldMapService;
	}
}

/** Inclusive coordinate ranges covering [c - r, c + r] on a wrapped axis (1 or 2 ranges). */
function ranges(c: number, r: number): [number, number][] {
	if (2 * r + 1 >= MAP_SIZE) return [[MAP_MIN, MAP_MAX]];
	const lo = wrap(c - r);
	const hi = wrap(c + r);
	return lo <= hi
		? [[lo, hi]]
		: [
				[lo, MAP_MAX],
				[MAP_MIN, hi],
			];
}

export default definePlugin({
	id: 'world-map',
	version: '0.1.0',
	description: 'Wrapping 1024x1024 tile map and tile occupancy',
	dependsOn: ['ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv);
		const markers = new Map<string, (api: ReadApi, ids: string[]) => Promise<Map<string, Omit<MapMarker, 'x' | 'y'>>>>();
		const layers: {
			draw: (api: ReadApi, tiles: Tile[]) => Promise<Map<string, Partial<GridCell>>>;
			legend?: () => { fill: string; label: UiText }[];
		}[] = [];
		/** Where "home" is: a plugin may say (e.g. the selected settlement); else nowhere in particular. */
		let homeOf: (api: ReadApi, params: Record<string, string>) => Promise<Tile | null> = async () => null;
		const service: WorldMapService = {
			wrap,
			distance: (a, b) => Math.hypot(delta(a.x, b.x), delta(a.y, b.y)),
			ring: (a, b) => Math.max(Math.abs(delta(a.x, b.x)), Math.abs(delta(a.y, b.y))),
			square(centre, radius) {
				const out: Tile[] = [];
				for (let dy = -radius; dy <= radius; dy++) {
					for (let dx = -radius; dx <= radius; dx++) out.push({ x: wrap(centre.x + dx), y: wrap(centre.y + dy) });
				}
				return out;
			},

			async occupants(api, tiles) {
				const out = new Map<string, string>();
				// Two bound parameters per tile; D1 allows 100 per query.
				for (let i = 0; i < tiles.length; i += 50) {
					const chunk = tiles.slice(i, i + 50);
					const { results } = await api.db
						.prepare(`SELECT x, y, entity FROM world_map_tiles WHERE ${chunk.map(() => '(x = ? AND y = ?)').join(' OR ')}`)
						.bind(...chunk.flatMap((t) => [t.x, t.y]))
						.all<Tile & { entity: string }>();
					for (const r of results) out.set(tileKey(r), r.entity);
				}
				return out;
			},

			async window(api, centre, radius) {
				const out: (Tile & { entity: string })[] = [];
				for (const [x1, x2] of ranges(centre.x, radius)) {
					for (const [y1, y2] of ranges(centre.y, radius)) {
						const { results } = await api.db
							.prepare('SELECT x, y, entity FROM world_map_tiles WHERE x BETWEEN ? AND ? AND y BETWEEN ? AND ?')
							.bind(x1, x2, y1, y2)
							.all<Tile & { entity: string }>();
						out.push(...results);
					}
				}
				return out;
			},

			async claim(api, tiles, entity) {
				const taken = await service.occupants(api, tiles);
				if (taken.size) throw new GameError('tile_taken', `Tile ${[...taken.keys()][0]} is already occupied`, 409);
				api.write(
					...tiles.map((t) => api.db.prepare('INSERT INTO world_map_tiles (x, y, entity) VALUES (?, ?, ?)').bind(t.x, t.y, entity)),
				);
			},

			release(api, entity) {
				api.write(api.db.prepare('DELETE FROM world_map_tiles WHERE entity = ?').bind(entity));
			},

			async findFreeSquare(api, radius, attempts = 30) {
				for (let i = 0; i < attempts; i++) {
					const [rx, ry] = crypto.getRandomValues(new Uint32Array(2));
					const centre = { x: wrap(MAP_MIN + (rx % MAP_SIZE)), y: wrap(MAP_MIN + (ry % MAP_SIZE)) };
					if ((await service.occupants(api, service.square(centre, radius))).size === 0) return centre;
				}
				return null;
			},

			addSide: (side) => void sides.push(side),
			addLayer: (draw, legend) => void layers.splice(layers.length - 1, 0, { draw, ...(legend ? { legend } : {}) }),
			setHome: (home) => void (homeOf = home),
			addMarkers(prefix, describe) {
				if (markers.has(prefix)) throw new PluginError(`Map markers for "${prefix}" registered twice`);
				markers.set(prefix, describe);
			},
		};

		ctx.services.provide('worldMap', service);

		// Markers in a window: `?x=&y=&r=` (r <= 25).
		ctx.views.add({
			id: 'world-map.markers',
			async compute(api, params): Promise<MapMarker[]> {
				if (!markers.size || params.x === undefined || params.y === undefined) return [];
				const x = Number(params.x);
				const y = Number(params.y);
				if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
				const r = Math.min(25, Math.max(0, Math.floor(Number(params.r ?? 7)) || 0));
				const tiles = await service.window(api, { x: wrap(Math.floor(x)), y: wrap(Math.floor(y)) }, r);
				const out: MapMarker[] = [];
				for (const [prefix, describe] of markers) {
					const mine = tiles.filter((t) => t.entity.startsWith(`${prefix}:`));
					if (!mine.length) continue;
					const found = await describe(api, [...new Set(mine.map((t) => t.entity.slice(prefix.length + 1)))]);
					for (const t of mine) {
						const m = found.get(t.entity.slice(prefix.length + 1));
						if (m) out.push({ x: t.x, y: t.y, ...m });
					}
				}
				return out;
			},
		});
		// The map as a generic grid: layers from other plugins (terrain, settlements...), and the markers.
		const markerLayer = async (api: ReadApi, tiles: Tile[]) => {
			const out = new Map<string, Partial<GridCell>>();
			if (!markers.size) return out;
			const held = await service.occupants(api, tiles);
			for (const [prefix, describe] of markers) {
				const mine = [...held].filter(([, e]) => e.startsWith(`${prefix}:`));
				if (!mine.length) continue;
				const found = await describe(api, [...new Set(mine.map(([, e]) => e.slice(prefix.length + 1)))]);
				for (const [key, e] of mine) {
					const m = found.get(e.slice(prefix.length + 1));
					if (m)
						out.set(key, {
							icon: m.icon,
							tone: 'marked',
							title: [{ text: m.name }],
							info: [{ text: { text: '{icon} {name}', vars: { icon: m.icon ?? '', name: m.name } } }],
						});
				}
			}
			return out;
		};
		layers.push({ draw: markerLayer });
		const sides: ((api: ReadApi, centre: Tile, params: ViewParams) => Promise<GridSide | null>)[] = [];
		ctx.views.add({
			id: 'world-map.grid',
			async compute(api, params): Promise<GridData> {
				const num = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Math.floor(Number(v)) : null);
				const home = await homeOf(api, params);
				const centre = { x: wrap(num(params.x) ?? home?.x ?? 0), y: wrap(num(params.y) ?? home?.y ?? 0) };
				const radius = Math.min(25, Math.max(0, num(params.r) ?? 7));
				const tiles = service.square(centre, radius);
				const cells = new Map<string, GridCell>(tiles.map((t) => [tileKey(t), { x: t.x, y: t.y }]));
				for (const { draw } of layers)
					for (const [key, part] of await draw(api, tiles)) {
						const c = cells.get(key);
						if (!c) continue;
						const { title, info, actions, ...rest } = part;
						Object.assign(c, rest);
						if (title) c.title = [...(c.title ?? []), ...title];
						if (info) c.info = [...(c.info ?? []), ...info];
						if (actions) c.actions = [...(c.actions ?? []), ...actions];
					}
				for (const c of cells.values()) if (!c.tone) c.info = [...(c.info ?? []), { text: { text: 'Free land.' }, tone: 'muted' }];
				return {
					title: { text: 'Map' },
					minX: MAP_MIN,
					minY: MAP_MIN,
					width: MAP_SIZE,
					height: MAP_SIZE,
					wrap: true,
					centre,
					radius,
					...(home ? { home } : {}),
					cells: [...cells.values()],
					legend: layers.flatMap((l) => l.legend?.() ?? []),
					placement: 'tile',
					sides: (await Promise.all(sides.map((side) => side(api, centre, params)))).filter((x): x is GridSide => !!x),
				};
			},
		});
		ctx.meta.add('map', () => ({ min: MAP_MIN, max: MAP_MAX }));

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.page({ id: 'map', label: 'Map', order: 10, widget: 'ui.grid', props: { view: 'world-map.grid', grid: 'world' } });
	},
});
