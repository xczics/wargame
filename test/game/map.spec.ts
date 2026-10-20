/** The map: terrain, the overview of nearby settlements and the generic grid. */
import { describe, expect, it } from 'vitest';
import { computeViews, createKernel, definePlugin, engineContext } from '../../src/kernel';
import clock from '../../examples/clock/server';
import otherworld from '../../examples/otherworld/server';
import { plugins } from '../../src/plugins';
import { wrap } from '../../src/plugins/world-map';
import type { NearbyOverview, TerrainWindow, UiLayout } from '../../src/shared/api';
import type { GridData } from '../../src/shared/ui';
import { env } from 'cloudflare:workers';
import { db, files, T0, defaultKernel, player, inbox, outer } from '../helpers';

const TILES = 1024 * 1024;

describe('terrain', () => {
	it('gives the district on it a production bonus; painting it settles first', async () => {
		const p = player({ 'terrain.bonus': {} }); // the real bonuses
		const c = await p.start();
		const o = outer(c);
		await p.construct(T0, c.id, o.id, 0, 'lumber-mill'); // 10 s; 440 wood left
		// Grassland (the default) does nothing for wood: 1/s.
		expect((await p.pool(T0 + 20_000)).amounts.wood).toBeCloseTo(450);
		await p.run(T0 + 20_000, 'terrain.paint', { x: o.x, y: o.y, width: 1, height: 1, terrain: 'forest' }, true);
		const pool = await p.pool(T0 + 30_000);
		expect(pool.extra.wood).toBeCloseTo(0.3); // forest: +30% wood
		expect(pool.amounts.wood).toBeCloseTo(450 + 13);
		// The map view shows it, and candidate tiles name their terrain.
		const w = (await p.views(T0 + 30_000, ['terrain.window'], { x: String(o.x), y: String(o.y), radius: '1' }))[
			'terrain.window'
		] as TerrainWindow;
		expect(w.rows[1][1]).toBe('f');
		const d = await p.detail(T0 + 30_000);
		const near = d.nextOuter!.candidates[0];
		expect(d.terrain![`${near.x},${near.y}`]).toMatchObject({ terrain: expect.any(String) });
		expect(d.terrain![`${o.x},${o.y}`]).toMatchObject({ terrain: 'forest', bonus: { wood: 30 } });
	});

	it('lets a fog plugin hide tiles; imports the whole map as one file and reports the shares', async () => {
		const fog = definePlugin({
			id: 'test-fog',
			version: '0',
			dependsOn: ['terrain'],
			setup(ctx) {
				ctx.services
					.get('terrain')
					.addVisibility(async (_api, _player, tiles) => new Set(tiles.filter((t) => t.x % 2 === 0).map((t) => `${t.x},${t.y}`)));
			},
		});
		const p = player({}, createKernel([...plugins, fog]));
		await p.start();
		const w = (await p.views(T0, ['terrain.window'], { x: '0', y: '0', radius: '1' }))['terrain.window'] as TerrainWindow;
		expect(w.rows[1]).toBe('?g?'); // x = -1 and 1 are hidden

		const gm = player();
		// The last chunk ore veins, the rest grassland (the file runs chunk by chunk).
		const map = 'g'.repeat(TILES - 1024) + 'v'.repeat(1024);
		await expect(gm.run(T0, 'terrain.importMap', { data: map.slice(1) + 'x' }, true)).rejects.toThrow(/Unknown terrain code/);
		await expect(gm.run(T0, 'terrain.importMap', { data: 'g' }, true)).rejects.toThrow(/terrain codes/);
		await gm.run(T0, 'terrain.importMap', { data: map }, true);
		const file = (await db.prepare('SELECT file FROM terrain_version WHERE id = 1').first<{ file: string }>())!.file;
		expect(await (await env.FILES.get(`terrain/${file}.txt`))!.text()).toBe(map);
		const kernel = defaultKernel;
		const report = kernel.reports.get('terrain.shares')!;
		const rows = await report.run(
			{
				...engineContext(kernel, gm.id, T0),
				files,
				db,
				services: kernel.services,
				memo: (_k: string, l: () => Promise<unknown>) => l(),
				isFresh: () => false,
				peek: () => undefined,
				fresh: () => {},
			} as never,
			{},
		);
		expect(rows.find((r) => r.terrain === 'terrain.Ore vein')!.tiles).toBe(1024);
	});

	it('names a map file by its content; two GM changes at once both land (the map is locked)', async () => {
		const gm = player();
		const name = async () => (await db.prepare('SELECT file FROM terrain_version WHERE id = 1').first<{ file: string }>())!.file;
		const paint = (x: number, terrain: string) => gm.run(T0, 'terrain.paint', { x, y: 300, width: 1, height: 1, terrain }, true);
		await paint(300, 'desert');
		const first = await name();
		await paint(300, 'desert'); // the same map again: the same file
		expect(await name()).toBe(first);
		await Promise.all([paint(301, 'pond'), paint(302, 'river')]);
		const w = (await gm.views(T0, ['terrain.window'], { x: '301', y: '300', radius: '1' }))['terrain.window'] as TerrainWindow;
		expect(w.rows[1]).toBe('dpr');
	});

	it('keeps the file in force per isolate under the rules version; a change of the map moves that version on', async () => {
		const gm = player();
		const rules = async () => (await db.prepare('SELECT version FROM gm_config_version WHERE id = 1').first<number>('version')) ?? 0;
		const tile = async (rulesVersion: number) => {
			const ctx = { ...engineContext(defaultKernel, gm.id, T0), files, rulesVersion };
			const { views } = await computeViews(defaultKernel, db, ctx, ['terrain.window'], { x: '303', y: '300', radius: '0' });
			return (views['terrain.window'] as TerrainWindow).rows[0];
		};
		const before = await rules();
		await gm.run(T0, 'terrain.paint', { x: 303, y: 300, width: 1, height: 1, terrain: 'desert' }, true);
		const after = await rules();
		expect(after).toBe(before + 1);
		expect(await tile(after)).toBe('d');
		// Another isolate's request with that version reads no row (the file's name is known).
		const sql: string[] = [];
		const counted = new Proxy(db, {
			get: (t, k) => (k === 'prepare' ? (q: string) => (sql.push(q), t.prepare(q)) : Reflect.get(t, k, t)),
		});
		const ctx = { ...engineContext(defaultKernel, gm.id, T0), files, rulesVersion: after };
		await computeViews(defaultKernel, counted as D1Database, ctx, ['terrain.window'], { x: '303', y: '300', radius: '0' });
		expect(sql.filter((q) => q.includes('terrain_version'))).toEqual([]);
	});

	it('moves a world from before 1.4 (one database row per chunk) into a map file', async () => {
		const gm = player();
		const before = await db.prepare('SELECT version, file FROM terrain_version WHERE id = 1').first<{ version: number; file: string }>();
		await db.batch([
			db.prepare('UPDATE terrain_version SET file = NULL WHERE id = 1'),
			db.prepare('INSERT OR REPLACE INTO terrain_chunks (cx, cy, data) VALUES (0, 0, ?)').bind('m'.repeat(1024)),
		]);
		try {
			// Read from the rows until then: chunk (0, 0) is the corner at (-511, -511).
			const at = async () =>
				((await gm.views(T0, ['terrain.window'], { x: '-511', y: '-511', radius: '0' }))['terrain.window'] as TerrainWindow).rows[0];
			expect(await at()).toBe('m');
			await gm.run(T0, 'terrain.exportToFile', null, true);
			expect(await at()).toBe('m');
			const file = (await db.prepare('SELECT file FROM terrain_version WHERE id = 1').first<{ file: string }>())!.file;
			expect((await (await env.FILES.get(`terrain/${file}.txt`))!.text()).slice(0, 1024)).toBe('m'.repeat(1024));
			await expect(gm.run(T0, 'terrain.exportToFile', null, true)).rejects.toThrow(/already/);
		} finally {
			await db.prepare('DELETE FROM terrain_chunks').run();
			if (before)
				await db
					.prepare('UPDATE terrain_version SET version = ?, file = ? WHERE id = 1')
					.bind(before.version + 10, before.file)
					.run();
		}
	});
});

describe('map overview', () => {
	it('lists the settlements around a point, nearest first, within a radius, NPCs only on request', async () => {
		const p = player();
		const c = await p.start();
		const near = { x: wrap(c.x + 4), y: c.y }; // 4 tiles
		const diagonal = { x: wrap(c.x + 3), y: wrap(c.y + 4) }; // 5 tiles
		const far = { x: wrap(c.x + 30), y: c.y };
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-fortress', ...diagonal }, true);
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...near }, true);
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...far }, true);
		// Someone else's fortress next door, and our own one (never listed).
		const q = player();
		await q.start();
		await q.run(T0, 'settlements.found', { kind: 'fortress-military', x: wrap(c.x - 4), y: c.y, name: 'Neighbour' }, true);
		await p.run(T0, 'settlements.found', { kind: 'fortress-military', x: c.x, y: wrap(c.y - 4), name: 'Mine' }, true);

		const nearby = async (params: Record<string, string>) =>
			((await p.views(T0, ['settlements.nearby'], params))['settlements.nearby'] as NearbyOverview).settlements.filter(
				(s) => [near, diagonal, far].some((t) => t.x === s.x && t.y === s.y) || ['Neighbour', 'Mine'].includes(s.name),
			);
		const around = await nearby({ r: '10' });
		expect(around.map((s) => s.distance)).toEqual([4, 4, 5]);
		expect(around.slice(0, 2).map((s) => s.kind)).toEqual(expect.arrayContaining(['npc-outpost', 'fortress-military']));
		expect(around[2].kind).toBe('npc-fortress');
		// Camps carry their level (the npc-camps plugin's, through settlements.addNearbyInfo); players' places none.
		expect(around.find((s) => s.kind === 'npc-outpost')!.level).toBeGreaterThanOrEqual(1);
		expect(around.find((s) => s.kind === 'fortress-military')!.level).toBeUndefined();
		expect(around.find((s) => s.kind === 'fortress-military')).toMatchObject({
			name: 'Neighbour',
			npc: false,
			ownerName: null, // engine tests have no accounts, so no names
		});
		expect((await nearby({ r: '10', npc: '1' })).map((s) => s.kind)).toEqual(['npc-outpost', 'npc-fortress']);
		expect((await nearby({ r: '50', npc: '1' })).map((s) => s.distance)).toEqual([4, 5, 30]);
		// Around another point, e.g. where the map is looking.
		expect((await nearby({ x: String(far.x), y: String(far.y), r: '1', npc: '1' })).map((s) => s.distance)).toEqual([0]);

		// The GM caps the radius (settlements.nearbyRadius): larger requests are cut to it.
		const capped = player({ 'settlements.nearbyRadius': 6 });
		const overview = (await capped.views(T0, ['settlements.nearby'], { x: String(c.x), y: String(c.y), r: '50', npc: '1' }))[
			'settlements.nearby'
		] as NearbyOverview;
		expect(overview.maxRadius).toBe(6);
		expect(overview.settlements.every((s) => s.distance <= 6)).toBe(true);
		expect(overview.settlements.some((s) => s.x === far.x && s.y === far.y)).toBe(false);
	});
});

describe('generic grid (ui.grid)', () => {
	it('draws the world map from layers: terrain fills, settlements, home, legend, the tile forms', async () => {
		const p = player();
		const c = await p.start();
		const g = (await p.views(T0, ['world-map.grid'], { x: String(c.x), y: String(c.y), r: '2' }))['world-map.grid'] as GridData;
		// Beside it, the NPC settlements around the centre, as far as the side's choice says.
		expect(g.sides?.[0]).toMatchObject({
			title: { text: 'settlements.NPC settlements nearby' },
			choice: { param: 'nearbyR', selected: '20' },
		});
		const wider = (await p.views(T0, ['world-map.grid'], { x: String(c.x), y: String(c.y), r: '2', nearbyR: '10' }))[
			'world-map.grid'
		] as GridData;
		expect(wider.sides?.[0].choice?.selected).toBe('10');
		expect(g).toMatchObject({
			wrap: true,
			width: 1024,
			radius: 2,
			centre: { x: c.x, y: c.y },
			home: { x: c.x, y: c.y },
			placement: 'tile',
		});
		// Only the cells something is on (the capital, its outer city, starter camps...); the ground is drawn by the client.
		expect(g.cells.length).toBeLessThan(25);
		const capital = g.cells.find((x) => x.x === c.x && x.y === c.y)!;
		expect(capital).toMatchObject({ icon: '🏰', tone: 'mine', actions: [{ params: { settlement: c.id } }] });
		expect(capital.fill).toBeUndefined();
		// The ground: one cacheable map file (named by its content), the table in meta, and per terrain what it gives here.
		expect(g.ground).toMatchObject({
			size: 32,
			chunks: 32,
			meta: 'terrains',
		});
		const table = defaultKernel.meta.get('terrains')!() as { code: string; fill: string }[];
		expect(Object.keys(g.ground!.info!).sort()).toEqual(table.map((t) => t.code).sort());
		expect(g.emptyInfo).toEqual([{ text: { text: 'world-map.Free land.' }, tone: 'muted' }]);
		// The GM paints a tile: a new map file (browsers fetch it once; the old one stays theirs until then).
		await p.run(T0, 'terrain.paint', { x: wrap(c.x + 2), y: c.y, width: 1, height: 1, terrain: 'forest' }, true);
		const again = (await p.views(T0, ['world-map.grid'], { x: String(c.x), y: String(c.y), r: '2' }))['world-map.grid'] as GridData;
		expect(again.ground!.file).toMatch(/^terrain\/[0-9a-f]{20}\.txt$/);
		expect(again.ground!.file).not.toBe(g.ground!.file);
	});

	it('is reusable by a third party without client code: the otherworld example, a small grid of its own', async () => {
		const kernel = createKernel([...plugins, otherworld]);
		const layout = kernel.meta.get('ui')!() as UiLayout;
		expect(layout.pages).toContainEqual(
			expect.objectContaining({ id: 'otherworld', widget: 'ui.grid', props: { gridView: 'otherworld.grid', grid: 'otherworld' } }),
		);
		expect(layout.mail['otherworld.scouted']).toBe('ui.report');
		const p = player(undefined, kernel);
		await p.start();
		const g = (await p.views(T0, ['otherworld.grid']))['otherworld.grid'] as GridData;
		expect(g).toMatchObject({ width: 5, height: 5, wrap: false });
		const demon = g.cells.find((x) => x.icon === '👹')!;
		expect(demon).toMatchObject({ x: 4, y: 4, tone: 'enemy', actions: [{ command: 'otherworld.scout', payload: { x: 4, y: 4 } }] });
		// Its button sends a mail shown as a generic report; a tile with nobody is refused.
		await p.run(T0, 'otherworld.scout', { x: 4, y: 4 });
		const mail = (await inbox(p, T0)).messages[0];
		expect(mail).toMatchObject({ kind: 'otherworld.scouted', report: { tone: 'bad' } });
		await expect(p.run(T0, 'otherworld.scout', { x: 0, y: 0 })).rejects.toThrow(/Nobody lives there/);
	});

	it('takes extensions with a client widget of their own: the clock example', async () => {
		const kernel = createKernel([...plugins, clock]);
		const layout = kernel.meta.get('ui')!() as UiLayout;
		expect(layout.bands).toContainEqual(
			expect.objectContaining({ band: 'bottom', widget: 'clock.time', props: { view: 'clock.settings' } }),
		);
		expect((await player(undefined, kernel).views(T0, ['clock.settings']))['clock.settings']).toEqual({ utcOffset: 8 });
		expect((await player({ 'clock.utcOffset': -5 }, kernel).views(T0, ['clock.settings']))['clock.settings']).toEqual({ utcOffset: -5 });
	});
});
