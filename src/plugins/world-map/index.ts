/**
 * World map: a 1024 x 1024 grid whose edges wrap on both axes (x and y run from -511 to
 * +512; -511 and +512 are neighbours). Topologically a torus: walking off one edge brings
 * you back on the opposite one.
 *
 * Only occupied tiles are stored (`world_map_tiles`, primary key (x, y)), so two
 * commands racing for the same tile cannot both succeed: the second batch fails on the
 * key and nothing of it is written.
 */
import { definePlugin, GameError, type EngineApi, type ReadApi } from '../../kernel';

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
	setup(ctx) {
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
		};

		ctx.services.provide('worldMap', service);
		ctx.meta.add('map', () => ({ min: MAP_MIN, max: MAP_MAX }));
	},
});
