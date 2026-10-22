/**
 * World map: a 1024 x 1024 grid whose edges wrap on both axes (x and y run from -511 to
 * +512; -511 and +512 are neighbours). Topologically a torus: walking off one edge brings
 * you back on the opposite one.
 *
 * Only occupied tiles are stored (`world_map_tiles`, primary key (x, y)), so two
 * commands racing for the same tile cannot both succeed: the second batch fails on the
 * key and nothing of it is written.
 */
import {
	definePlugin,
	type EngineApi,
	type FlatContext,
	gameErrors,
	playerStamp,
	PluginError,
	type ReadApi,
	type ViewParams,
} from '../../kernel';
import type { MapMarker, MapWindow, MapWindowMarkers } from '../../shared/api';
import type { GridGround } from '../../shared/ui';
import i18nCsv from './data/i18n.csv?raw';
import { uiTexts } from '../../shared/i18n';

const fail = gameErrors('world-map');
const text = uiTexts('world-map');

export const MAP_MIN = -511;
export const MAP_MAX = 512;
export const MAP_SIZE = MAP_MAX - MAP_MIN + 1;
/** Tiles a side of a block of the map's versions (migration 0033). */
const BLOCK = 32;
const blockOf = (x: number, y: number) => `${Math.floor((x - MAP_MIN) / BLOCK)},${Math.floor((y - MAP_MIN) / BLOCK)}`;

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
	/** Occupant entity by tile key, for the given tiles only: stored ones, then those of virtual sources (`addVirtual`) on free tiles. */
	occupants(api: ReadApi, tiles: Tile[]): Promise<Map<string, string>>;
	/** Stored occupants only (the tile table, and claims of this call): for virtual sources deciding where theirs stand. */
	stored(api: ReadApi, tiles: Tile[]): Promise<Map<string, string>>;
	/**
	 * The flat form of `stored` for one tile (`Command.flat`): rows of { entity }, none when it is free; `also`: more
	 * columns, SQL over the column `entity` (e.g. `settlements.ownerSql`: who holds it), in the same statement.
	 */
	flatStored(f: FlatContext, tile: Tile, also?: Record<string, string>): D1PreparedStatement;
	/**
	 * What the map shows at `tile` changed without a stored tile or settlement row changing (those move the map's
	 * versions by trigger, migration 0033), e.g. a camp the rules place beaten: the windows around it are worked out again.
	 */
	changed(api: EngineApi, tile: Tile): void;
	/** Occupied tiles in the square window around `centre`, virtual occupants included unless `virtual: false` (stored only, e.g. the whole map). */
	window(api: ReadApi, centre: Tile, radius: number, options?: { virtual?: boolean }): Promise<(Tile & { entity: string })[]>;
	/**
	 * Occupants that are not stored but worked out (e.g. NPC camps placed by a rule): `at` says which of these tiles
	 * hold one of yours (entity by tile key), `area` lists yours in a square window (without visiting every tile).
	 * Claims and every occupancy question see them; a stored occupant on the same tile wins.
	 */
	addVirtual(source: VirtualOccupants): void;
	/** Forget what this call learned from virtual sources (one of them just changed, e.g. a camp was uprooted). */
	forget(api: ReadApi): void;
	/** Queue the claim of free tiles for `entity`. Throws if any is taken. */
	claim(api: EngineApi, tiles: Tile[], entity: string): Promise<void>;
	/** Queue releasing every tile of `entity`. */
	release(api: EngineApi, entity: string): void;
	/** A random centre whose whole (2r+1)^2 square is free, or null after `attempts` tries. */
	findFreeSquare(api: ReadApi, radius: number, attempts?: number): Promise<Tile | null>;
	/** Tiles a side (the map wraps around). */
	readonly size: number;
	/**
	 * Show tiles held by entities "<prefix>:<id>" on the map (layer `markers` of view `world-map.window`), e.g. realms.
	 * `describe` gets the ids found in the window and returns what to show for each (missing = not shown).
	 */
	addMarkers(prefix: string, describe: (api: ReadApi, ids: string[]) => Promise<Map<string, MapMarker>>): void;
	/**
	 * Data for the map (data view `world-map.window`; the client view `world-map.grid` draws it, generic widget `ui.grid`):
	 * for the tiles of a window (`held`: who holds each, "x,y" -> entity), whatever layer `id` needs, under
	 * `layers[id]` (e.g. the settlements there, by id). Data only (ids, numbers, names as keys): what each tile then
	 * shows is drawn in the browser by the client layer of the same id (web/plugins/world-map). Null: nothing to send.
	 * Must only read.
	 */
	addLayer(id: string, layer: (api: ReadApi, tiles: Tile[], held: Map<string, string>) => Promise<unknown>): void;
	/**
	 * Data for a list beside the map's grid for the window around `centre` (`sides[id]`, drawn by the client layer `id`);
	 * `params` are the request's. `area`: how far around the centre it reads the map (`window`), so the window's view
	 * reads it all in one query first.
	 */
	addSide(
		id: string,
		side: (api: ReadApi, centre: Tile, params: ViewParams) => Promise<unknown>,
		area?: (params: ViewParams) => number,
	): void;
	/** What lies under every tile, drawn by the client (`GridGround`; e.g. terrain): one plugin gives it. */
	setGround(ground: (api: ReadApi, tiles: Tile[]) => Promise<GridGround>): void;
	/** Where the map's "home" button goes for the acting player (e.g. the selected settlement). */
	setHome(home: (api: ReadApi, params: Record<string, string>) => Promise<Tile | null>): void;
}

export interface VirtualOccupants {
	at(api: ReadApi, tiles: Tile[]): Promise<Map<string, string>>;
	area(api: ReadApi, centre: Tile, radius: number): Promise<(Tile & { entity: string })[]>;
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
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const markers = new Map<string, (api: ReadApi, ids: string[]) => Promise<Map<string, MapMarker>>>();
		const layers = new Map<string, (api: ReadApi, tiles: Tile[], held: Map<string, string>) => Promise<unknown>>();
		const sides = new Map<string, (api: ReadApi, centre: Tile, params: ViewParams) => Promise<unknown>>();
		const sideAreas: ((params: ViewParams) => number)[] = [];
		/** The window a request asks for: its centre (default: the player's home) and radius. */
		const areaOf = async (api: ReadApi, params: ViewParams) => {
			const num = (v: string | undefined) => (v !== undefined && Number.isFinite(Number(v)) ? Math.floor(Number(v)) : null);
			const home = await homeOf(api, params);
			const centre = { x: wrap(num(params.x) ?? home?.x ?? 0), y: wrap(num(params.y) ?? home?.y ?? 0) };
			return { home, centre, radius: Math.min(25, Math.max(0, num(params.r) ?? 7)) };
		};
		/** The map's version blocks (32 x 32, as migration 0033's triggers) a square of `radius` around `centre` touches. */
		const blocksAround = (centre: Tile, radius: number) => {
			const axis = (c: number) => {
				const out = new Set<number>();
				for (let d = -radius; d <= radius; d++) out.add(Math.floor((wrap(c + d) - MAP_MIN) / BLOCK));
				return [...out];
			};
			const ys = axis(centre.y);
			return axis(centre.x).flatMap((bx) => ys.map((by) => `${bx},${by}`));
		};
		let groundOf: ((api: ReadApi, tiles: Tile[]) => Promise<GridGround>) | null = null;
		/** Where "home" is: a plugin may say (e.g. the selected settlement); else nowhere in particular. */
		let homeOf: (api: ReadApi, params: Record<string, string>) => Promise<Tile | null> = async () => null;
		/**
		 * What this call already knows about tiles: the windows and tiles it read (every tile in them, taken or not) and
		 * the tiles it claimed since. `occupants` answers from it where it can (e.g. seeding a block it just read).
		 */
		const known = (api: ReadApi) =>
			api.memo('world-map:known', async () => ({
				areas: [] as { c: Tile; r: number }[],
				seen: new Set<string>(),
				tiles: new Map<string, string>(),
			}));
		const virtuals: VirtualOccupants[] = [];
		/** What virtual sources said in this call: about tiles (null: none of theirs), and the windows they listed whole. */
		const virtualKnown = (api: ReadApi) =>
			api.memo('world-map:virtual', async () => ({ tiles: new Map<string, string | null>(), areas: [] as { c: Tile; r: number }[] }));
		// Asked for every tile of a window and what stands around its camps: the wrapping worked out inline.
		const covered = (areas: { c: Tile; r: number }[], t: Tile) => {
			for (const a of areas) {
				const dx = ((((t.x - a.c.x - MAP_MIN) % MAP_SIZE) + MAP_SIZE) % MAP_SIZE) + MAP_MIN;
				if (dx > a.r || dx < -a.r) continue;
				const dy = ((((t.y - a.c.y - MAP_MIN) % MAP_SIZE) + MAP_SIZE) % MAP_SIZE) + MAP_MIN;
				if (dy <= a.r && dy >= -a.r) return true;
			}
			return false;
		};
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
				const out = await service.stored(api, tiles);
				if (!virtuals.length) return out;
				const vk = await virtualKnown(api);
				// (Each tile's key once: a window asks for hundreds.)
				const keys = tiles.map(tileKey);
				const ask = tiles.filter((t, i) => !out.has(keys[i]) && !vk.tiles.has(keys[i]) && !covered(vk.areas, t));
				if (ask.length) {
					const found = new Map<string, string>();
					for (const v of virtuals) for (const [key, e] of await v.at(api, ask)) if (!found.has(key)) found.set(key, e);
					for (const t of ask) vk.tiles.set(tileKey(t), found.get(tileKey(t)) ?? null);
				}
				for (const key of keys) {
					const e = !out.has(key) && vk.tiles.get(key);
					if (e) out.set(key, e);
				}
				return out;
			},
			addVirtual: (source) => void virtuals.push(source),
			forget: (api) =>
				void virtualKnown(api).then((vk) => {
					vk.tiles.clear();
					vk.areas.length = 0;
				}),

			flatStored: (f, { x, y }, also = {}) =>
				f.db
					.prepare(
						`SELECT ${['entity', ...Object.entries(also).map(([k, sql]) => `${sql} AS ${k}`)].join(', ')} FROM world_map_tiles WHERE x = ? AND y = ?`,
					)
					.bind(x, y),
			changed: (api, { x, y }) =>
				api.write(
					api.db
						.prepare(
							'INSERT INTO world_map_versions (block, version) VALUES (?, 1) ON CONFLICT (block) DO UPDATE SET version = version + 1',
						)
						.bind(blockOf(x, y)),
				),
			async stored(api, tiles) {
				const out = new Map<string, string>();
				const k = await known(api);
				const ask: Tile[] = [];
				for (const t of tiles) {
					const key = tileKey(t);
					if (!k.seen.has(key) && !covered(k.areas, t)) ask.push(t);
					else {
						const e = k.tiles.get(key);
						if (e !== undefined) out.set(key, e);
					}
				}
				// Two bound parameters per tile; D1 allows 100 per query.
				for (let i = 0; i < ask.length; i += 50) {
					const chunk = ask.slice(i, i + 50);
					const { results } = await api.db
						.prepare(`SELECT x, y, entity FROM world_map_tiles WHERE ${chunk.map(() => '(x = ? AND y = ?)').join(' OR ')}`)
						.bind(...chunk.flatMap((t) => [t.x, t.y]))
						.all<Tile & { entity: string }>();
					for (const r of results) out.set(tileKey(r), r.entity);
				}
				// Remembered like a window's tiles, empty ones too (e.g. a gathering asks once for all its targets).
				for (const t of ask) {
					const key = tileKey(t);
					k.seen.add(key);
					const e = out.get(key);
					if (e && !k.tiles.has(key)) k.tiles.set(key, e);
				}
				return out;
			},

			async window(api, centre, radius, { virtual = true } = {}) {
				// With virtual sources, a ring more is read: whether theirs stand may depend on the tiles around them (one
				// query either way, none more for the window's edge).
				const read = virtual && virtuals.length ? radius + 1 : radius;
				// A wider square read in this call around the same centre already has them.
				const reads = await api.memo(
					'world-map:reads',
					async () => [] as { centre: Tile; read: number; rows: (Tile & { entity: string })[] }[],
				);
				const wider = reads.find((w) => w.centre.x === centre.x && w.centre.y === centre.y && w.read >= read);
				const rows: (Tile & { entity: string })[] = wider ? wider.rows.filter((r) => service.ring(r, centre) <= read) : [];
				if (!wider) reads.push({ centre, read, rows });
				for (const [x1, x2] of wider ? [] : ranges(centre.x, read)) {
					for (const [y1, y2] of ranges(centre.y, read)) {
						// The key is (x, y): a range of x reads every stored tile of those columns, whatever their y (1.4.1: ~600
						// rows for a 17 x 17 window on a world of stored camps); naming the columns seeks each one to the y range.
						// Up to 90 columns (bound values per statement: 100); wider windows (GM imports) keep the range.
						const columns = x2 - x1 + 1;
						const { results } = await (
							columns <= 90
								? api.db
										.prepare(
											`SELECT x, y, entity FROM world_map_tiles WHERE x IN (${Array(columns).fill('?').join(', ')}) AND y BETWEEN ? AND ?`,
										)
										.bind(...Array.from({ length: columns }, (_, i) => x1 + i), y1, y2)
								: api.db
										.prepare('SELECT x, y, entity FROM world_map_tiles WHERE x BETWEEN ? AND ? AND y BETWEEN ? AND ?')
										.bind(x1, x2, y1, y2)
						).all<Tile & { entity: string }>();
						rows.push(...results);
					}
				}
				// Remembered for `occupants` (claims made earlier in this call are newer than the rows: they win).
				const k = await known(api);
				for (const r of rows) if (!k.tiles.has(tileKey(r))) k.tiles.set(tileKey(r), r.entity);
				k.areas.push({ c: centre, r: read });
				const out = read === radius ? rows : rows.filter((r) => service.ring(r, centre) <= radius);
				if (virtual && virtuals.length) {
					const vk = await virtualKnown(api);
					const taken = new Set(out.map(tileKey));
					for (const v of virtuals)
						for (const t of await v.area(api, centre, radius)) {
							if (taken.has(tileKey(t))) continue;
							taken.add(tileKey(t));
							vk.tiles.set(tileKey(t), t.entity);
							out.push(t);
						}
					// Every other tile of the window holds none of theirs.
					vk.areas.push({ c: centre, r: radius });
				}
				return out;
			},

			async claim(api, tiles, entity) {
				const taken = await service.occupants(api, tiles);
				if (taken.size) throw fail('tile_taken', text('Tile {0} is already occupied', { 0: [...taken.keys()][0] }), 409);
				const k = await known(api);
				for (const t of tiles) k.tiles.set(tileKey(t), entity);
				api.write(
					...tiles.map((t) => api.db.prepare('INSERT INTO world_map_tiles (x, y, entity) VALUES (?, ?, ?)').bind(t.x, t.y, entity)),
				);
			},

			release(api, entity) {
				api.write(api.db.prepare('DELETE FROM world_map_tiles WHERE entity = ?').bind(entity));
				// Its tiles are not known here: forget what this call knew, so later questions go to the table.
				void known(api).then((k) => {
					k.areas.length = 0;
					k.seen.clear();
					k.tiles.clear();
				});
			},

			size: MAP_SIZE,
			async findFreeSquare(api, radius, attempts = 30) {
				for (let i = 0; i < attempts; i++) {
					const [rx, ry] = crypto.getRandomValues(new Uint32Array(2));
					const centre = { x: wrap(MAP_MIN + (rx % MAP_SIZE)), y: wrap(MAP_MIN + (ry % MAP_SIZE)) };
					if ((await service.occupants(api, service.square(centre, radius))).size === 0) return centre;
				}
				return null;
			},

			addSide(id, side, area) {
				if (sides.has(id)) throw new PluginError(`Map side "${id}" registered twice`);
				sides.set(id, side);
				if (area) sideAreas.push(area);
			},
			setGround(ground) {
				if (groundOf) throw new PluginError('The map ground is given twice');
				groundOf = ground;
			},
			addLayer(id, draw) {
				if (layers.has(id)) throw new PluginError(`Map layer "${id}" registered twice`);
				layers.set(id, draw);
			},
			setHome: (home) => void (homeOf = home),
			addMarkers(prefix, describe) {
				if (markers.has(prefix)) throw new PluginError(`Map markers for "${prefix}" registered twice`);
				const own = ctx.services.get('i18n').scope();
				markers.set(prefix, async (api, ids) => {
					const out = await describe(api, ids);
					for (const m of out.values()) m.name = own(m.name);
					return out;
				});
			},
		};

		ctx.services.provide('worldMap', service);

		// The map's markers as a layer: what each marked entity in the window is (by entity), drawn by the client.
		layers.set('markers', async (api, _tiles, held) => {
			const out: MapWindowMarkers = {};
			for (const [prefix, describe] of markers) {
				const mine = [...new Set([...held.values()].filter((e) => e.startsWith(`${prefix}:`)))];
				if (!mine.length) continue;
				const found = await describe(
					api,
					mine.map((e) => e.slice(prefix.length + 1)),
				);
				for (const e of mine) {
					const m = found.get(e.slice(prefix.length + 1));
					if (m) out[e] = m;
				}
			}
			return Object.keys(out).length ? out : null;
		});
		// The map's data for a window (the client view `world-map.grid` draws it): who holds which tile, each layer's
		// data about them, the sides' lists, the ground. Nothing to display: every text is put together in the browser.
		ctx.views.add({
			id: 'world-map.window',
			// Changes with what the player's commits touch, the map's versions of the blocks it covers (anyone's moves
			// there), the rules and every ten minutes (camps refilling count down in the browser from its `now`).
			async stamp(api, params) {
				const { centre, radius } = await areaOf(api, params);
				const read = Math.max(radius + 1, ...sideAreas.map((a) => a(params)));
				const blocks = blocksAround(centre, read);
				const { results } = await api.db
					.prepare(`SELECT block, version FROM world_map_versions WHERE block IN (${blocks.map(() => '?').join(', ')})`)
					.bind(...blocks)
					.all<{ block: string; version: number }>();
				const versions = results.map((r) => `${r.block}:${r.version}`).sort();
				return `${await playerStamp(api)}|${api.rulesVersion ?? 0}|${await api.version('world')}|${Math.floor(api.now / 600_000)}|${versions.join(';')}`;
			},
			async compute(api, params): Promise<MapWindow> {
				const { home, centre, radius } = await areaOf(api, params);
				const tiles = service.square(centre, radius);
				// Everything stored the window and the side lists need, in one range query (theirs filter it). Only what is
				// stored: what virtual sources work out from rules the browser works out itself (e.g. the rule camps,
				// web/plugins/npc-camps), user 2026-10-22: "规则生成的甚至连列表都不用转". A ring more than the window: what
				// stands on its edge may depend on it.
				await service.window(api, centre, Math.max(radius + 1, ...sideAreas.map((a) => a(params))), { virtual: false });
				const held = new Map((await service.window(api, centre, radius + 1, { virtual: false })).map((t) => [tileKey(t), t.entity]));
				const data: Record<string, unknown> = {};
				for (const [id, draw] of layers) {
					const d = await draw(api, tiles, held);
					if (d !== null && d !== undefined) data[id] = d;
				}
				const lists: Record<string, unknown> = {};
				for (const [id, side] of sides) {
					const d = await side(api, centre, params);
					if (d !== null && d !== undefined) lists[id] = d;
				}
				return {
					centre,
					radius,
					...(home ? { home } : {}),
					now: api.now,
					held: Object.fromEntries(held),
					layers: data,
					sides: lists,
					...(groundOf ? { ground: await groundOf(api, tiles) } : {}),
				};
			},
		});
		ctx.meta.add('map', () => ({ min: MAP_MIN, max: MAP_MAX }));

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.page({ id: 'map', label: 'Map', order: 10, widget: 'ui.grid', props: { gridView: 'world-map.grid', grid: 'world' } });
	},
});
