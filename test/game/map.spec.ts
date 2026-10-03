/** The map: terrain, the overview of nearby settlements and the generic grid. */
import { describe, expect, it } from 'vitest';
import { createKernel, definePlugin, engineContext } from '../../src/kernel';
import clock from '../../examples/clock/server';
import otherworld from '../../examples/otherworld/server';
import { plugins } from '../../src/plugins';
import { wrap } from '../../src/plugins/world-map';
import type { NearbyOverview, TerrainWindow, UiLayout } from '../../src/shared/api';
import type { GridData } from '../../src/shared/ui';
import { db, T0, defaultKernel, player, inbox, outer } from '../helpers';

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

	it('lets a fog plugin hide tiles; imports whole chunks and reports the shares', async () => {
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
		await expect(gm.run(T0, 'terrain.importChunks', { chunks: [{ cx: 31, cy: 31, data: 'x'.repeat(1024) }] }, true)).rejects.toThrow(
			/Unknown terrain code/,
		);
		await gm.run(T0, 'terrain.importChunks', { chunks: [{ cx: 31, cy: 31, data: 'v'.repeat(1024) }] }, true);
		const kernel = defaultKernel;
		const report = kernel.reports.get('terrain.shares')!;
		const rows = await report.run(
			{
				...engineContext(kernel, gm.id, T0),
				db,
				services: kernel.services,
				memo: (_k: string, l: () => Promise<unknown>) => l(),
				isFresh: () => false,
				fresh: () => {},
			} as never,
			{},
		);
		expect(rows.find((r) => r.terrain === 'terrain.Ore vein')!.tiles).toBeGreaterThanOrEqual(1024);
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
		expect(g.cells).toHaveLength(25);
		const capital = g.cells.find((x) => x.x === c.x && x.y === c.y)!;
		expect(capital).toMatchObject({
			icon: '🏰',
			tone: 'mine',
			fill: expect.stringMatching(/^terrain-/),
			actions: [{ params: { settlement: c.id } }],
		});
		expect(g.legend!.length).toBeGreaterThan(3);
	});

	it('is reusable by a third party without client code: the otherworld example, a small grid of its own', async () => {
		const kernel = createKernel([...plugins, otherworld]);
		const layout = kernel.meta.get('ui')!() as UiLayout;
		expect(layout.pages).toContainEqual(
			expect.objectContaining({ id: 'otherworld', widget: 'ui.grid', props: { view: 'otherworld.grid', grid: 'otherworld' } }),
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
