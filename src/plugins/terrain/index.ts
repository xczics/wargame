/**
 * Terrain (docs/design/gameplay.md §4): every map tile has one. The terrain under a district
 * adds a production bonus by resource to its buildings (via `buildings.addDistrictBonus`);
 * it does not limit building or marching. Kinds and bonuses are in ./data (CSV); other
 * plugins may add kinds with `define`.
 *
 * Storage: the whole map is ONE file in the object storage (`terrain/<hash>.txt`, 1024 x 1024 one-letter codes,
 * chunk by chunk: 32 x 32 chunks in rows, each 32 x 32 codes row by row), so a tile is one character at a known
 * offset, read without parsing. The database only says which file is in force (`terrain_version`). Isolates keep
 * a file once read (it never changes under its name); browsers fetch the same file once and keep it. The map is set
 * before opening (`map:generate` / `map:import`) and afterwards only by the GM: every change writes a new file
 * (`EngineApi.putFile`) and switches to it in the same commit, after settling the resources of the settlements on
 * the changed land, like any other change of production rates. Worlds from before (one D1 row per chunk,
 * `terrain_chunks`) are read as they are until `terrain.exportToFile` turns them into a file.
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
/** Each map file read in this isolate, by name: a name never changes its content. */
const mapFiles = new Map<string, Promise<string | null>>();
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
const CELLS = CHUNK * CHUNK;
const TILES = CHUNKS * CHUNKS * CELLS;
/** Where a tile's code is in the map file (chunk by chunk). */
const offsetOf = (t: Tile) => {
	const { cx, cy } = chunkOf(t);
	return (cy * CHUNKS + cx) * CELLS + indexIn(t);
};
const fileKey = (name: string) => `terrain/${name}.txt`;
async function contentName(text: string) {
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
	return [...digest.slice(0, 10)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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

		/** Which map file is in force (null: none yet), and a counter that moves on with every change. */
		const loadCurrent = (api: ReadApi) =>
			api.memo('terrain:current', async () => {
				const row = await api.db
					.prepare('SELECT version, file FROM terrain_version WHERE id = 1')
					.first<{ version: number; file: string | null }>();
				return { version: row?.version ?? 1, file: row?.file ?? null };
			});
		/** The whole map (chunk by chunk), or null: no file yet (read the old chunk rows), or no object storage here. */
		const loadMap = (api: ReadApi) =>
			api.memo('terrain:map', async (): Promise<{ text: string | null }> => {
				const { file } = await loadCurrent(api);
				if (!file || !api.files) return { text: null };
				let read = mapFiles.get(file);
				if (!read) {
					mapFiles.set(file, (read = api.files.get(fileKey(file))));
					void read.then((t) => t === null && mapFiles.delete(file));
				}
				const text = await read;
				if (text === null) console.error(`The terrain file ${file} is missing: showing the default terrain`);
				return { text };
			});
		/** One tile's code (undefined: the default terrain). */
		async function codeAt(api: ReadApi, t: Tile): Promise<string | undefined> {
			const { text } = await loadMap(api);
			if (text) return text[offsetOf(t)];
			const { cx, cy } = chunkOf(t);
			return (await loadChunk(api, cx, cy)).data?.[indexIn(t)];
		}

		/** Chunk data by key (null = never written: all default). Only worlds without a map file yet. */
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
				// One printable ASCII character: the map file is read by offset, one byte a tile.
				if (!/^[!-~]$/.test(def.code) || def.code === '?' || byCode.has(def.code))
					throw new PluginError(`Terrain "${def.id}": code must be one unused printable ASCII character (not "?")`);
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
					const code = await codeAt(api, t);
					out.set(`${t.x},${t.y}`, (code && byCode.get(code)?.id) || fallback().id);
				}
				return out;
			},
			async at(api, tile) {
				return (await service.of(api, [tile])).get(`${tile.x},${tile.y}`)!;
			},
			async mix(api, tile) {
				const { cx, cy } = chunkOf(tile);
				const { text } = await loadMap(api);
				const start = (cy * CHUNKS + cx) * CELLS;
				const data = text ? text.slice(start, start + CELLS) : (await loadChunk(api, cx, cy)).data;
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
				const edit = await editMap(api);
				await settleOn(api, tiles);
				for (const t of tiles) {
					const { cx, cy } = chunkOf(t);
					const chunk = cy * CHUNKS + cx;
					let cells = edit.chunks.get(chunk);
					if (!cells) edit.chunks.set(chunk, (cells = [...edit.base.slice(chunk * CELLS, (chunk + 1) * CELLS)]));
					cells[indexIn(t)] = def.code;
				}
			},
			addVisibility: (f) => void visibility.push(f),
			addBonus: (b) => void extraBonuses.push(b),
		};
		ctx.services.provide('terrain', service);
		service.defineFromCsv(terrainsCsv);

		/**
		 * The map being changed by this command: the text it started from and the chunks changed so far. Written once,
		 * just before the commit, as a new file named by its content; the command's lock on the map makes concurrent GM
		 * changes retry instead of overwriting each other.
		 */
		const editMap = (api: EngineApi) =>
			api.memo('terrain:edit', async () => {
				await api.lock('terrain:map');
				const edit = { base: await mapText(api), chunks: new Map<number, string[]>() };
				api.beforeCommit('terrain:file', async () => {
					if (!edit.chunks.size) return;
					let next = '';
					let from = 0;
					for (const chunk of [...edit.chunks.keys()].sort((a, b) => a - b)) {
						next += edit.base.slice(from, chunk * CELLS) + edit.chunks.get(chunk)!.join('');
						from = (chunk + 1) * CELLS;
					}
					next += edit.base.slice(from);
					await useMap(api, next);
				});
				return edit;
			});
		/** The whole map as text: the file in force, else the old chunk rows (every chunk at once: GM changes only). */
		async function mapText(api: ReadApi): Promise<string> {
			const { text } = await loadMap(api);
			if (text) return text;
			const { results } = await api.db.prepare('SELECT cx, cy, data FROM terrain_chunks').all<{ cx: number; cy: number; data: string }>();
			const chunks = Array<string>(CHUNKS * CHUNKS).fill(fallback().code.repeat(CELLS));
			for (const r of results) chunks[r.cy * CHUNKS + r.cx] = r.data;
			return chunks.join('');
		}
		/** Put `text` as the map file and switch to it with this command (later reads in the same call see it). */
		async function useMap(api: EngineApi, next: string) {
			const name = await contentName(next);
			api.putFile(fileKey(name), next, { contentType: 'text/plain; charset=utf-8', cacheControl: 'public, max-age=31536000, immutable' });
			mapFiles.set(name, Promise.resolve(next));
			api.write(
				api.db
					.prepare(
						'INSERT INTO terrain_version (id, version, file) VALUES (1, 2, ?) ON CONFLICT (id) DO UPDATE SET version = version + 1, file = excluded.file',
					)
					.bind(name),
			);
			(await loadMap(api)).text = next;
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
		// The map file when the bucket has no public URL (FILES_BASE_URL): kept by browsers for good (its name is its
		// content). Players only: the map shows what is where.
		ctx.routes.add({
			method: 'GET',
			path: '/api/files/terrain/:name',
			async handler({ request, env, params, services }) {
				await services.get('session').resolve(request, env);
				const file = /^[0-9a-f]{20}\.txt$/.test(params.name) ? await env.FILES?.get(`terrain/${params.name}`) : null;
				if (!file) return new Response('no such map file', { status: 404 });
				return new Response(file.body, {
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
				...(await loadCurrent(api).then(({ file }) => (file ? { file: fileKey(file) } : {}))),
				size: CHUNK,
				chunks: CHUNKS,
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

		// Inside a character class only the backslash, ] ^ and - are special (escaping letters would make d, f... classes).
		const codesPattern = () => new RegExp(`^[${[...byCode.keys()].map((c) => c.replace(/[\\\]^-]/g, '\\$&')).join('')}]*$`);
		ctx.commands.add<{ data: string }>({
			type: 'terrain.importMap',
			privileged: true,
			description:
				'Replace the whole map (used by `pnpm map:import`): { "data": "<1024 x 1024 terrain codes, chunk by chunk: 32 x 32 chunks in rows, each 32 x 32 codes row by row>" }. Settles the settlements on changed land first (at most 50).',
			parse: shape({ data: fields.raw() }, (p) => {
				if (typeof p.data !== 'string' || p.data.length !== TILES)
					throw fail('bad_payload', text('data must be {0} terrain codes', { 0: TILES }));
				// One native pass: a JavaScript loop over a million characters would eat the request's CPU.
				if (!codesPattern().test(p.data)) throw fail('bad_payload', 'Unknown terrain code in data');
				return { data: p.data };
			}),
			async execute(api, { data }) {
				const edit = await editMap(api);
				// Settle what stands on changed chunks (one read of the whole map's occupied tiles: before opening, few).
				const changed = new Set<number>();
				for (let chunk = 0; chunk < CHUNKS * CHUNKS; chunk++)
					if (data.slice(chunk * CELLS, (chunk + 1) * CELLS) !== edit.base.slice(chunk * CELLS, (chunk + 1) * CELLS)) changed.add(chunk);
				const tiles = (await map.window(api, { x: 0, y: 0 }, CHUNKS * CHUNK, { virtual: false })).filter((t) => {
					const { cx, cy } = chunkOf(t);
					return changed.has(cy * CHUNKS + cx);
				});
				const standing = new Set(tiles.map((t) => t.entity).filter((e) => e.startsWith('settlement:')));
				if (standing.size > 50)
					throw fail('too_many', text('{0} settlements stand on the changed land: change it in parts (paint)', { 0: standing.size }));
				await settleOn(api, tiles);
				for (const chunk of changed) edit.chunks.set(chunk, [...data.slice(chunk * CELLS, (chunk + 1) * CELLS)]);
			},
		});

		ctx.commands.add<null>({
			type: 'terrain.exportToFile',
			privileged: true,
			description: 'Turn a world from before 1.4 (one database row per chunk) into a map file in the object storage. Payload: none.',
			form: {
				title: text('Move the map into a file'),
				placement: 'gm',
				fields: [],
				submitLabel: text('Move'),
				async prepare(api) {
					return (await loadCurrent(api)).file ? false : {};
				},
			},
			parse: () => null,
			async execute(api) {
				await api.lock('terrain:map');
				if ((await loadCurrent(api)).file) throw fail('done', 'The map is already a file');
				await useMap(api, await mapText(api));
			},
		});

		ctx.reports.add({
			id: 'terrain.shares',
			description: 'How much of the map each terrain covers (tiles and %), against its target share.',
			async run(api) {
				// Counted by splitting on each code: native, where a loop over a million characters is not.
				const all = await mapText(api);
				const counts = new Map([...byCode.keys()].map((c) => [c, all.split(c).length - 1]));
				const total = TILES;
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
