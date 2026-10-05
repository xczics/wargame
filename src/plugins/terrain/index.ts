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
	type EngineApi,
	fields,
	gameErrors,
	numberInRange,
	PluginError,
	type ReadApi,
	recordOf,
	shape,
} from '../../kernel';
import { signed } from '../../shared/format';
import type { GridGround, UiLine } from '../../shared/ui';
import type { TerrainWindow } from '../../shared/api';
import type { Settlement } from '../settlements';
import type { Tile } from '../world-map';
import bonusCsv from './data/bonus.csv?raw';
import terrainsCsv from './data/terrains.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, uiTexts } from '../../shared/i18n';

const fail = gameErrors('terrain');
const text = uiTexts('terrain');

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
	/** How many tiles of each terrain the map chunk around `tile` holds (e.g. to draw something by the land around it). */
	mix(api: ReadApi, tile: Tile): Promise<Record<string, number>>;
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
	dependsOn: ['world-map', 'settlements', 'buildings', 'resources', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
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
				def = { ...def, name: ctx.services.get('i18n').own(def.name) };
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
			async mix(api, tile) {
				const { cx, cy } = chunkOf(tile);
				const { data } = await loadChunk(api, cx, cy);
				if (!data) return { [fallback().id]: CHUNK * CHUNK };
				const out: Record<string, number> = {};
				for (const code of data) {
					const id = byCode.get(code)?.id ?? fallback().id;
					out[id] = (out[id] ?? 0) + 1;
				}
				return out;
			},
			bonus: (api, terrain) => bonuses.get(api)[terrain] ?? {},
			async set(api, tiles, terrain) {
				const def = defs.get(terrain);
				if (!def) throw fail('bad_payload', text('Unknown terrain "{0}"', { 0: terrain }));
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

		// The map's version: chunks are served under it (cached by browsers for good), so any change moves it on.
		const loadVersion = (api: ReadApi) =>
			api.memo('terrain:version', async () => {
				const row = await api.db.prepare('SELECT version FROM terrain_version WHERE id = 1').first<{ version: number }>();
				return row?.version ?? 1;
			});
		async function writeChunk(api: EngineApi, cx: number, cy: number, data: string) {
			api.beforeCommit('terrain:version', () =>
				api.write(
					api.db.prepare('INSERT INTO terrain_version (id, version) VALUES (1, 2) ON CONFLICT (id) DO UPDATE SET version = version + 1'),
				),
			);
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
		}, text('Terrain'));

		// The settlement page shows the terrain under each district and each outer-city candidate.
		settlements.addDetailExtender(
			async (api, s, detail) => {
				const tiles = [...detail.districts, ...(detail.nextOuter?.candidates ?? [])].map(({ x, y }) => ({ x, y }));
				const found = await service.of(api, tiles);
				detail.terrain = {};
				for (const [key, t] of found) detail.terrain[key] = { terrain: t, name: defs.get(t)?.name, bonus: { ...service.bonus(api, t) } };
				// Extra bonuses (e.g. research on rivers) for this settlement.
				for (const v of Object.values(detail.terrain))
					for (const extra of extraBonuses)
						for (const [r, pct] of Object.entries(await extra(api, s, v.terrain))) v.bonus[r] = (v.bonus[r] ?? 0) + pct;
			},
			{ light: true },
		);

		/* ----- map view ------------------------------------------------------------------ */

		// The code table of the map's ground (generic grid): loaded once with the page.
		ctx.meta.add('terrains', () => service.list().map(({ id, code, name }) => ({ id, code, name, fill: `terrain-${id}` })));

		// One chunk of the map as text (32 x 32 codes; empty = all the default terrain), kept by the browser: its URL
		// carries the map's version, so it is read from D1 once a version (user 2026-10-05: cache the terrain on the client).
		ctx.routes.add({
			method: 'GET',
			path: '/api/terrain/chunk',
			async handler({ request, env, url, services }) {
				await services.get('session').resolve(request, env);
				const cx = Number(url.searchParams.get('cx'));
				const cy = Number(url.searchParams.get('cy'));
				if (!Number.isInteger(cx) || !Number.isInteger(cy) || cx < 0 || cy < 0 || cx >= CHUNKS || cy >= CHUNKS)
					return new Response('bad chunk', { status: 400 });
				const row = await env.DB.prepare('SELECT data FROM terrain_chunks WHERE cx = ? AND cy = ?').bind(cx, cy).first<{ data: string }>();
				return new Response(row?.data ?? '', {
					headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'private, max-age=31536000, immutable' },
				});
			},
		});

		// The ground of the map: the chunks above and the table in meta; per sync only what changes with rules or the
		// player: each terrain's production bonus here (user 2026-10-05: "地图界面，显示空地信息时，要同时显示地形带来的加成效果。")
		// and fogged tiles.
		map.setGround(async (api, tiles): Promise<GridGround> => {
			let visible: Set<string> | null = null;
			for (const f of visibility) if ((visible = await f(api, api.playerId, tiles))) break;
			const capital = await settlements.capital(api, api.playerId);
			const icons = new Map(resources.list().map((r) => [r.id, r.icon ?? r.id]));
			const info: Record<string, UiLine[]> = {};
			for (const d of defs.values()) {
				const bonus = { ...service.bonus(api, d.id) };
				if (capital)
					for (const extra of extraBonuses)
						for (const [r, pct] of Object.entries(await extra(api, capital, d.id))) bonus[r] = (bonus[r] ?? 0) + pct;
				const parts = Object.entries(bonus)
					.filter(([, pct]) => pct)
					.map(([r, pct]) => text('{0}{1}', { 0: icons.get(r) ?? r, 1: signed(pct, true, 0) }));
				info[d.code] = [
					parts.length
						? { text: text('Outer cities and resource fortresses here: {0}', { 0: parts }), tone: 'info' }
						: { text: text('No production bonus here'), tone: 'muted' },
				];
			}
			return {
				src: `/api/terrain/chunk?v=${await loadVersion(api)}&cx={cx}&cy={cy}`,
				size: CHUNK,
				meta: 'terrains',
				info,
				...(visible ? { hidden: tiles.map((t) => `${t.x},${t.y}`).filter((k) => !visible!.has(k)), unknown: 'terrain-unknown' } : {}),
			};
		});

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
				title: text('Paint terrain'),
				placement: 'gm',
				fields: [
					{ name: 'x', label: text('x'), type: 'number', required: true, min: -511, max: 512 },
					{ name: 'y', label: text('y'), type: 'number', required: true, min: -511, max: 512 },
					{ name: 'width', label: text('Width'), type: 'number', required: true, min: 1, max: 64, default: 1 },
					{ name: 'height', label: text('Height'), type: 'number', required: true, min: 1, max: 64, default: 1 },
					{ name: 'terrain', label: text('Terrain'), type: 'select', required: true },
				],
				submitLabel: text('Paint'),
				async prepare() {
					return { options: { terrain: service.list().map((t) => ({ value: t.id, label: keyText(t.name) })) } };
				},
			},
			parse: shape({
				x: fields.int(-511, 512),
				y: fields.int(-511, 512),
				width: fields.orElse(fields.int(1, 64), 1),
				height: fields.orElse(fields.int(1, 64), 1),
				terrain: fields.id(),
			}),
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
			parse: shape(
				{
					chunks: fields.list(
						fields.object({
							cx: fields.int(0, CHUNKS - 1),
							cy: fields.int(0, CHUNKS - 1),
							data: fields.text({ min: CHUNK * CHUNK, max: CHUNK * CHUNK * 2 }),
						}),
						{ min: 1, max: 8 },
					),
				},
				// One terrain code per tile (codes may be any character, so count code points).
				(p) => {
					for (const { data } of p.chunks) {
						if ([...data].length !== CHUNK * CHUNK) throw fail('bad_payload', 'data must be 1024 terrain codes');
						for (const ch of data) if (!byCode.has(ch)) throw fail('bad_payload', text('Unknown terrain code "{0}"', { 0: ch }));
					}
					return p;
				},
			),
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
