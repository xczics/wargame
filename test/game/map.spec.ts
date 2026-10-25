/** The map: terrain, the overview of nearby settlements and the generic grid. */
import { describe, expect, it } from 'vitest';
import { createKernel, definePlugin, type EngineApi, engineContext, type Kernel } from '../../src/kernel';
import clock from '../../examples/clock/server';
import otherworld from '../../examples/otherworld/server';
import { scouted } from '../../examples/otherworld/report';
import { plugins } from '../../src/plugins';
import { wrap } from '../../src/plugins/world-map';
import type { MapWindow, MapWindowSettlements, NearbyOverview, UiLayout } from '../../src/shared/api';
import type { GridData } from '../../src/shared/ui';
import { env } from 'cloudflare:workers';
import { db, files, T0, defaultKernel, player, inbox, outer } from '../helpers';
import { probe } from '../probe';

const TILES = 1024 * 1024;
/** The terrain codes of the square around (x, y), `r` tiles out, row by row, as the terrain service has them. */
const codesIn = async (api: EngineApi, kernel: Kernel, x: number, y: number, r: number) => {
	const terrain = kernel.services.get('terrain');
	const code = new Map(terrain.list().map((t) => [t.id, t.code]));
	const rows: { x: number; y: number }[][] = [];
	for (let dy = -r; dy <= r; dy++) rows.push(Array.from({ length: 2 * r + 1 }, (_, i) => ({ x: wrap(x - r + i), y: wrap(y + dy) })));
	const found = await terrain.of(api, rows.flat());
	return rows.map((row) => row.map((t) => code.get(found.get(`${t.x},${t.y}`)!)).join(''));
};
const codes = (p: ReturnType<typeof player>, now: number, x: number, y: number, r: number) =>
	p.probe(now, (api, kernel) => codesIn(api, kernel, x, y, r));

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
		expect((await codes(p, T0 + 30_000, o.x, o.y, 1))[1][1]).toBe('f');
		const d = await p.detail(T0 + 30_000);
		const near = d.nextOuter!.candidates[0];
		expect(d.terrain![`${near.x},${near.y}`]).toMatchObject({ terrain: expect.any(String) });
		expect(d.terrain![`${o.x},${o.y}`]).toMatchObject({ terrain: 'forest', bonus: { wood: 30 } });
		// Commands keep a settlement's own tiles' terrain in one row by its id (no new isolate reads the whole map for
		// production or its page); after the map changed, the row (of the older map) is read again and rewritten.
		const row = async () => {
			const r = await db
				.prepare('SELECT version, codes FROM terrain_settlements WHERE settlement_id = ?')
				.bind(c.id)
				.first<{ version: number; codes: string }>();
			return r ? { version: r.version, codes: JSON.parse(r.codes) as Record<string, string> } : null;
		};
		const before = await row();
		expect(Object.keys(before!.codes)).toContain(`${c.x},${c.y}`);
		await p.construct(T0 + 40_000, c.id, o.id, 1, 'lumber-mill');
		const after = await row();
		expect(after!.codes[`${o.x},${o.y}`]).toBe('f');
		expect(after!.version).toBeGreaterThan(before!.version);
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
		const w = (await p.views(T0, ['world-map.window'], { x: '0', y: '0', r: '1' }))['world-map.window'] as MapWindow;
		expect(w.ground!.hidden).toEqual(expect.arrayContaining(['-1,0', '1,0']));
		expect(w.ground!.hidden).not.toContain('0,0'); // x = -1 and 1 are hidden

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
		expect((await codes(gm, T0, 301, 300, 1))[1]).toBe('dpr');
	});

	it('keeps the file in force per isolate under the rules version; a change of the map moves that version on', async () => {
		const gm = player();
		const rules = async () => (await db.prepare('SELECT version FROM gm_config_version WHERE id = 1').first<number>('version')) ?? 0;
		const tile = async (rulesVersion: number) => {
			const ctx = { ...engineContext(defaultKernel, gm.id, T0), files, rulesVersion };
			return (await probe(defaultKernel, ctx, (api, kernel) => codesIn(api, kernel, 303, 300, 0)))[0];
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
		await probe(defaultKernel, ctx, (api, kernel) => codesIn(api, kernel, 303, 300, 0), {}, counted as D1Database);
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
			const at = async () => (await codes(gm, T0, -511, -511, 0))[0];
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

describe('map window stamp', () => {
	it('stays while nothing there changes; moves with someone else founding nearby and with a camp beaten', async () => {
		const p = player();
		const c = await p.start();
		const at = { x: String(c.x), y: String(c.y), r: '7' };
		const stamp = async (now: number) => (await p.stamps(now, ['world-map.window'], at))['world-map.window'];
		const first = await stamp(T0 + 1_000);
		expect(first).toBeDefined();
		expect(await stamp(T0 + 2_000)).toBe(first);
		// Someone else's fortress in the window: another player's commit, nothing of ours.
		const q = player();
		await q.start();
		await q.run(
			T0 + 3_000,
			'settlements.found',
			{ kind: 'fortress-military', x: wrap(c.x + 5), y: wrap(c.y + 5), name: 'Next door' },
			true,
		);
		const second = await stamp(T0 + 4_000);
		expect(second).not.toBe(first);
		// A camp the rules place, beaten: no stored tile changes, its block moves on all the same.
		const tile = { x: wrap(c.x + 6), y: c.y };
		const writes: D1PreparedStatement[] = [];
		defaultKernel.services
			.get('worldMap')
			.changed({ db, write: (st: D1PreparedStatement) => void writes.push(st) } as unknown as EngineApi, tile);
		await db.batch(writes);
		expect(await stamp(T0 + 6_000)).not.toBe(second);
	});
});

describe('map overview', () => {
	it('lists the NPC settlements around a point, nearest first, within a radius, in the browser from the map data', async () => {
		const p = player();
		const c = await p.start();
		const near = { x: wrap(c.x + 4), y: c.y }; // 4 tiles
		const diagonal = { x: wrap(c.x + 3), y: wrap(c.y + 4) }; // 5 tiles
		const far = { x: wrap(c.x + 30), y: c.y };
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-fortress', ...diagonal }, true);
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...near }, true);
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...far }, true);
		// Someone else's fortress next door, and our own one (never listed: players' places are not NPCs).
		const q = player();
		await q.start();
		await q.run(T0, 'settlements.found', { kind: 'fortress-military', x: wrap(c.x - 4), y: c.y, name: 'Neighbour' }, true);
		await p.run(T0, 'settlements.found', { kind: 'fortress-military', x: c.x, y: wrap(c.y - 4), name: 'Mine' }, true);

		const nearby = async (params: Record<string, string>, who = p) =>
			(
				(await who.views(T0, ['settlements.nearby'], { x: String(c.x), y: String(c.y), r: '0', ...params }))[
					'settlements.nearby'
				] as NearbyOverview
			).settlements;
		const ours = (list: NearbyOverview['settlements']) => list.filter((s) => [near, diagonal, far].some((t) => t.x === s.x && t.y === s.y));
		const around = await nearby({ nearbyR: '10' });
		expect(around.some((s) => s.kind === 'fortress-military')).toBe(false);
		expect(ours(around).map((s) => [s.kind, s.distance])).toEqual([
			['npc-outpost', 4],
			['npc-fortress', 5],
		]);
		// Camps carry their level (the npc-camps client part, from what the map's data stores about them).
		expect(ours(around).every((s) => (s.level ?? 0) >= 1 && s.npc)).toBe(true);
		expect(ours(await nearby({ nearbyR: '50' })).map((s) => s.distance)).toEqual([4, 5, 30]);
		// Around another point, e.g. where the map is looking.
		expect(ours(await nearby({ x: String(far.x), y: String(far.y), nearbyR: '1' })).map((s) => s.distance)).toEqual([0]);

		// The GM caps the radius (settlements.nearbyRadius): larger requests are cut to it.
		const capped = player({ 'settlements.nearbyRadius': 6 });
		const overview = (await capped.views(T0, ['settlements.nearby'], { x: String(c.x), y: String(c.y), r: '0', nearbyR: '50' }))[
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
		// Drawn in the browser: the server sends what is where (data), not the cells' texts.
		const w = (await p.views(T0, ['world-map.window'], { x: String(c.x), y: String(c.y), r: '2' }))['world-map.window'] as MapWindow;
		expect(w.held[`${c.x},${c.y}`]).toBe(`settlement:${c.id}`);
		expect((w.layers.settlements as MapWindowSettlements)[c.id]).toMatchObject({ kind: 'capital', x: c.x, y: c.y, mine: true });
		expect(w.sides.settlements).toMatchObject({ r: 20 });
		expect(w).not.toHaveProperty('cells');
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

	it('keeps the lists beside the map to the rule, whatever radius the client asks (the stamp reads its blocks in slices)', async () => {
		const p = player();
		const c = await p.start();
		const at = { x: String(c.x), y: String(c.y), r: '7', nearbyR: '200' };
		// (A stamp over every block of a radius of 200 bound more than D1's 100 parameters a statement.)
		expect((await p.stamps(T0, ['world-map.window'], at))['world-map.window']).toBeTruthy();
		const w = (await p.views(T0, ['world-map.window'], at))['world-map.window'] as MapWindow;
		expect((w.sides.settlements as { r: number }).r).toBe(50);
		expect((w.sides['npc-camps'] as { r: number }).r).toBe(50);
	});

	it('is reusable by a third party: the otherworld example, a small grid of its own (no client code), its mail worded by its client half', async () => {
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
		// Its button sends a mail (data only), shown as a generic report by its client part; a tile with nobody is refused.
		await p.run(T0, 'otherworld.scout', { x: 4, y: 4 });
		const mail = (await inbox(p, T0)).messages[0];
		expect(mail).toMatchObject({ kind: 'otherworld.scouted', data: { x: 4, y: 4, icon: '👹', name: 'otherworld.Mountain demon' } });
		expect(scouted.part(mail, {} as never)).toMatchObject({ tone: 'bad' });
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
