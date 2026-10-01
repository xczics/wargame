/**
 * Terrain (docs/design/gameplay.md §4): every map tile has one. The terrain under a district
 * adds a production bonus by resource to its buildings (via `buildings.addDistrictBonus`);
 * it does not limit building or marching. Kinds and bonuses are in ./data (CSV); other
 * plugins may add kinds with `define`.
 *
 * Storage: 32 x 32 chunks, one row each (1024 one-character codes); chunks never written are
 * all the default terrain (the first kind). The map is set once before opening (scripts
 * `map:generate` / `map:import`) and afterwards only by the GM. Changing terrain settles the
 * resources of the settlements on it first, like any other change of production rates.
 *
 * Fog of war is left to other plugins: `addVisibility` may hide tiles from a player in the
 * map view (they show as unknown); without one, everything is visible.
 */
import {
	csvNumber,
	csvRows,
	definePlugin,
	GameError,
	numberInRange,
	PluginError,
	recordOf,
	type EngineApi,
	type ReadApi,
} from '../../kernel';
import type { TerrainWindow } from '../../shared/api';
import type { Settlement } from '../settlements';
import type { Tile } from '../world-map';
import bonusCsv from './data/bonus.csv?raw';
import terrainsCsv from './data/terrains.csv?raw';

export interface TerrainDef {
	id: string;
	/** One character, used in storage and map files. Never change it once maps use it. */
	code: string;
	name: string;
	/** Target share (%) for map generation. */
	share?: number;
}

/** Which of `tiles` a player may see (keys "x,y"); null = no opinion. Must only read. */
export type Visibility = (api: ReadApi, playerId: string, tiles: Tile[]) => Promise<Set<string> | null>;

export interface TerrainService {
	define(def: TerrainDef): void;
	defineFromCsv(csv: string): void;
	list(): readonly TerrainDef[];
	/** Terrain id of each tile, by "x,y". */
	of(api: ReadApi, tiles: Tile[]): Promise<Map<string, string>>;
	at(api: ReadApi, tile: Tile): Promise<string>;
	/** Production bonus (%) by resource of a district standing on `terrain`. */
	bonus(api: ReadApi, terrain: string): Record<string, number>;
	/** Change tiles (settles the settlements standing on them first). */
	set(api: EngineApi, tiles: Tile[], terrain: string): Promise<void>;
	addVisibility(filter: Visibility): void;
	/**
	 * More production (%) by resource for the districts of a settlement standing on `terrain`
	 * (e.g. irrigation research: food on rivers), added to the terrain's own bonus. Must only read.
	 */
	addBonus(bonus: (api: ReadApi, settlement: Settlement, terrain: string) => Promise<Record<string, number>>): void;
}

declare module '../../kernel' {
	interface ServiceMap {
		terrain: TerrainService;
	}
}

export const CHUNK = 32;
const CHUNKS = 32; // 1024 / 32 per axis
const MIN = -511;
const chunkOf = (t: Tile) => ({ cx: Math.floor((t.x - MIN) / CHUNK), cy: Math.floor((t.y - MIN) / CHUNK) });
const indexIn = (t: Tile) => ((t.y - MIN) % CHUNK) * CHUNK + ((t.x - MIN) % CHUNK);
const chunkKey = (cx: number, cy: number) => `${cx},${cy}`;

export default definePlugin({
	id: 'terrain',
	version: '0.1.0',
	description: 'Terrain of every map tile and its production bonus',
	dependsOn: ['world-map', 'settlements', 'buildings', 'resources'],
	setup(ctx) {
		const map = ctx.services.get('worldMap');
		const settlements = ctx.services.get('settlements');
		const buildings = ctx.services.get('buildings');
		const resources = ctx.services.get('resources');
		const defs = new Map<string, TerrainDef>();
		const byCode = new Map<string, TerrainDef>();
		const visibility: Visibility[] = [];
		const fallback = () => {
			const first = defs.values().next().value;
			if (!first) throw new PluginError('No terrain kinds defined');
			return first;
		};

		/** Chunk data by key (null = never written: all default). */
		const loadChunk = (api: ReadApi, cx: number, cy: number) =>
			api.memo(`terrain:chunk:${cx},${cy}`, async () => {
				const row = await api.db.prepare('SELECT data FROM terrain_chunks WHERE cx = ? AND cy = ?').bind(cx, cy).first<{ data: string }>();
				return { data: row?.data ?? null };
			});

		const extraBonuses: Parameters<TerrainService['addBonus']>[0][] = [];
		const service: TerrainService = {
			define(def) {
				if (defs.has(def.id)) throw new PluginError(`Terrain "${def.id}" defined twice`);
				if ([...def.code].length !== 1 || def.code === '?' || byCode.has(def.code))
					throw new PluginError(`Terrain "${def.id}": code must be one unused character (not "?")`);
				defs.set(def.id, def);
				byCode.set(def.code, def);
			},
			defineFromCsv(csv) {
				for (const r of csvRows(csv))
					service.define({ id: r.id, code: r.code, name: r.name, share: r.share ? csvNumber(r, 'share') : undefined });
			},
			list: () => [...defs.values()],
			async of(api, tiles) {
				const out = new Map<string, string>();
				for (const t of tiles) {
					const { cx, cy } = chunkOf(t);
					const { data } = await loadChunk(api, cx, cy);
					out.set(`${t.x},${t.y}`, (data && byCode.get(data[indexIn(t)])?.id) || fallback().id);
				}
				return out;
			},
			async at(api, tile) {
				return (await service.of(api, [tile])).get(`${tile.x},${tile.y}`)!;
			},
			bonus: (api, terrain) => bonuses.get(api)[terrain] ?? {},
			async set(api, tiles, terrain) {
				const def = defs.get(terrain);
				if (!def) throw new GameError('bad_payload', `Unknown terrain "${terrain}"`);
				await settleOn(api, tiles);
				const changed = new Map<string, { cx: number; cy: number; cells: string[] }>();
				for (const t of tiles) {
					const { cx, cy } = chunkOf(t);
					const key = chunkKey(cx, cy);
					if (!changed.has(key)) {
						const { data } = await loadChunk(api, cx, cy);
						changed.set(key, { cx, cy, cells: data ? [...data] : Array(CHUNK * CHUNK).fill(fallback().code) });
					}
					changed.get(key)!.cells[indexIn(t)] = def.code;
				}
				for (const { cx, cy, cells } of changed.values()) await writeChunk(api, cx, cy, cells.join(''));
			},
			addVisibility: (f) => void visibility.push(f),
			addBonus: (b) => void extraBonuses.push(b),
		};
		ctx.services.provide('terrain', service);
		service.defineFromCsv(terrainsCsv);

		async function writeChunk(api: EngineApi, cx: number, cy: number, data: string) {
			(await loadChunk(api, cx, cy)).data = data;
			api.write(
				api.db
					.prepare('INSERT INTO terrain_chunks (cx, cy, data) VALUES (?, ?, ?) ON CONFLICT (cx, cy) DO UPDATE SET data = excluded.data')
					.bind(cx, cy, data),
			);
		}

		/** Bank the resources of every settlement on `tiles` before their production changes (their owners are locked first). */
		async function settleOn(api: EngineApi, tiles: Tile[]) {
			const entities = new Set((await map.occupants(api, tiles)).values());
			for (const e of entities) {
				if (!e.startsWith('settlement:')) continue;
				const s = await settlements.get(api, e.slice('settlement:'.length));
				if (s?.ownerId && s.ownerId !== api.playerId) await api.lock(`player:${s.ownerId}`);
				await resources.settle(api, e);
			}
		}

		/* ----- production bonus ---------------------------------------------------------- */

		const BONUS: Record<string, Record<string, number>> = {};
		for (const row of csvRows(bonusCsv)) {
			const { terrain, ...cells } = row;
			BONUS[terrain] = Object.fromEntries(
				Object.entries(cells)
					.filter(([, v]) => v !== '')
					.map(([r]) => [r, csvNumber(row, r)]),
			);
		}
		const bonuses = ctx.config.define('bonus', {
			description:
				'Production bonus (%) of a district by the terrain it stands on, by resource. Partial: only the terrains given are replaced.',
			default: () => BONUS,
			parse: (raw) => ({
				...BONUS,
				...recordOf(
					() => defs.keys(),
					recordOf(
						() => resources.list().map((r) => r.id),
						(v) => numberInRange(-100, 1000)(v),
					),
				)(raw),
			}),
		});
		buildings.addDistrictBonus(async (api, settlement, district) => {
			const terrain = await service.at(api, district);
			const out = { ...service.bonus(api, terrain) };
			for (const extra of extraBonuses)
				for (const [r, pct] of Object.entries(await extra(api, settlement, terrain))) out[r] = (out[r] ?? 0) + pct;
			return out;
		});

		// Candidate tiles (e.g. for a new outer city) show their terrain and its bonus.
		settlements.addTileLabel(async (api, tile) => {
			const t = await service.at(api, tile);
			const b = Object.entries(service.bonus(api, t))
				.map(([r, pct]) => `${r} ${pct > 0 ? '+' : ''}${pct}%`)
				.join(', ');
			return b ? `${defs.get(t)!.name} (${b})` : defs.get(t)!.name;
		});

		/* ----- map view ------------------------------------------------------------------ */

		ctx.meta.add('terrains', () => service.list().map(({ id, code, name }) => ({ id, code, name })));

		ctx.views.add({
			id: 'terrain.window',
			async compute(api, params): Promise<TerrainWindow | null> {
				const x = Number(params.x);
				const y = Number(params.y);
				const radius = Math.min(32, Math.max(0, Math.floor(Number(params.radius ?? 7))));
				if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
				const centre = { x: map.wrap(x), y: map.wrap(y) };
				const tiles: Tile[] = [];
				for (let dy = -radius; dy <= radius; dy++)
					for (let dx = -radius; dx <= radius; dx++) tiles.push({ x: map.wrap(centre.x + dx), y: map.wrap(centre.y + dy) });
				const terrain = await service.of(api, tiles);
				// The first visibility filter with an opinion decides; without one everything shows.
				let visible: Set<string> | null = null;
				for (const f of visibility) if ((visible = await f(api, api.playerId, tiles))) break;
				const rows: string[] = [];
				for (let i = 0; i < tiles.length; i += 2 * radius + 1) {
					rows.push(
						tiles
							.slice(i, i + 2 * radius + 1)
							.map((t) => {
								const key = `${t.x},${t.y}`;
								return visible && !visible.has(key) ? '?' : defs.get(terrain.get(key)!)!.code;
							})
							.join(''),
					);
				}
				return { x: centre.x, y: centre.y, radius, rows };
			},
		});

		/* ----- GM ------------------------------------------------------------------------ */

		ctx.commands.add<{ x: number; y: number; width: number; height: number; terrain: string }>({
			type: 'terrain.paint',
			privileged: true,
			description:
				'Set the terrain of a rectangle of tiles (x, y = top-left corner; at most 64 x 64). Payload: { "x", "y", "width", "height", "terrain" }',
			form: {
				title: 'Paint terrain',
				placement: 'gm',
				fields: [
					{ name: 'x', label: 'x', type: 'number', required: true, min: -511, max: 512 },
					{ name: 'y', label: 'y', type: 'number', required: true, min: -511, max: 512 },
					{ name: 'width', label: 'Width', type: 'number', required: true, min: 1, max: 64, default: 1 },
					{ name: 'height', label: 'Height', type: 'number', required: true, min: 1, max: 64, default: 1 },
					{ name: 'terrain', label: 'Terrain', type: 'select', required: true },
				],
				submitLabel: 'Paint',
				async prepare() {
					return { options: { terrain: service.list().map((t) => ({ value: t.id, label: t.name })) } };
				},
			},
			parse(raw) {
				const p = (raw ?? {}) as Record<string, unknown>;
				const int = (v: unknown, min: number, max: number) => Math.floor(numberInRange(min, max)(Number(v)));
				if (typeof p.terrain !== 'string') throw new GameError('bad_payload', 'terrain is required');
				return {
					x: int(p.x, -511, 512),
					y: int(p.y, -511, 512),
					width: int(p.width ?? 1, 1, 64),
					height: int(p.height ?? 1, 1, 64),
					terrain: p.terrain,
				};
			},
			async execute(api, { x, y, width, height, terrain }) {
				const tiles: Tile[] = [];
				for (let dy = 0; dy < height; dy++) for (let dx = 0; dx < width; dx++) tiles.push({ x: map.wrap(x + dx), y: map.wrap(y + dy) });
				await service.set(api, tiles, terrain);
			},
		});

		ctx.commands.add<{ chunks: { cx: number; cy: number; data: string }[] }>({
			type: 'terrain.importChunks',
			privileged: true,
			description:
				'Replace whole chunks (used by `pnpm map:import`): { "chunks": [{ "cx": 0-31, "cy": 0-31, "data": "<1024 terrain codes, row by row>" }] }, at most 8 per call.',
			parse(raw) {
				const chunks = (raw as { chunks?: unknown } | null)?.chunks;
				if (!Array.isArray(chunks) || !chunks.length || chunks.length > 8) throw new GameError('bad_payload', 'Give 1-8 chunks');
				return {
					chunks: chunks.map((c) => {
						const { cx, cy, data } = (c ?? {}) as Record<string, unknown>;
						if (
							!Number.isInteger(cx) ||
							!Number.isInteger(cy) ||
							(cx as number) < 0 ||
							(cx as number) >= CHUNKS ||
							(cy as number) < 0 ||
							(cy as number) >= CHUNKS
						)
							throw new GameError('bad_payload', 'cx and cy must be 0-31');
						if (typeof data !== 'string' || [...data].length !== CHUNK * CHUNK)
							throw new GameError('bad_payload', 'data must be 1024 terrain codes');
						for (const ch of data) if (!byCode.has(ch)) throw new GameError('bad_payload', `Unknown terrain code "${ch}"`);
						return { cx: cx as number, cy: cy as number, data };
					}),
				};
			},
			async execute(api, { chunks }) {
				for (const { cx, cy, data } of chunks) {
					// Everything that stands in the chunk is settled before its terrain changes.
					const centre = { x: MIN + cx * CHUNK + CHUNK / 2, y: MIN + cy * CHUNK + CHUNK / 2 };
					await settleOn(api, await map.window(api, centre, CHUNK / 2));
					await writeChunk(api, cx, cy, data);
				}
			},
		});

		ctx.reports.add({
			id: 'terrain.shares',
			description: 'How much of the map each terrain covers (tiles and %), against its target share.',
			async run(api) {
				const counts = new Map<string, number>();
				const { results } = await api.db.prepare('SELECT data FROM terrain_chunks').all<{ data: string }>();
				for (const { data } of results) for (const ch of data) counts.set(ch, (counts.get(ch) ?? 0) + 1);
				// Chunks never written are all the default terrain.
				const def = fallback();
				counts.set(def.code, (counts.get(def.code) ?? 0) + (CHUNKS * CHUNKS - results.length) * CHUNK * CHUNK);
				const total = CHUNKS * CHUNKS * CHUNK * CHUNK;
				return service.list().map((t) => ({
					terrain: t.name,
					tiles: counts.get(t.code) ?? 0,
					percent: Math.round(((counts.get(t.code) ?? 0) / total) * 10000) / 100,
					target: t.share ?? null,
				}));
			},
		});
	},
});
