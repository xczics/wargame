/** NPC camps placed by a rule (1.4): worked out, not stored; only what happens to one is kept. */
import { describe, expect, it } from 'vitest';
import { wrap } from '../../src/plugins/world-map';
import type { ArmyInfo } from '../../src/shared/api';
import type { GridData } from '../../src/shared/ui';
import { engineContext, runReport } from '../../src/kernel';
import { db, defaultKernel, type MapTile, T0, player } from '../helpers';

const rule = (extra: Record<string, number> = {}) => ({
	'npc-camps.density': { seed: 7, blockSize: 16, perBlock: 12, spread: 0, fortressShare: 0.5, ...extra },
});
/** Every rule camp level 1, and level 1 easy to beat (and to uproot: all five lanes). */
const easy = {
	'npc-camps.spawn': { 1: 1, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0, 10: 0 },
	'npc-camps.levels': {
		'npc-fortress': { 1: { stockade: 0, lane: { 1: 5 }, loot: { 1: 2 } } },
		'npc-outpost': { 1: { stockade: 0, lane: { 1: 5 }, loot: { total: 1000 } } },
	},
	'armies.speed': 1e6,
	'armies.minSeconds': 0,
};
const ring = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(wrap(b.x - a.x)), Math.abs(wrap(b.y - a.y)));

type P = ReturnType<typeof player>;
const campsNear = async (p: P, x: number, y: number, r: number) =>
	(await p.tiles(T0, wrap(x), wrap(y), r)).filter((t) => t.settlement.startsWith('npc:')); // the rule's (a capital's starter camps are stored ones)
/** Rows about these camps, counted in batches (D1 binds at most 100 values a statement). */
const rowsAbout = async (table: string, column: string, ids: string[]) => {
	let n = 0;
	for (let i = 0; i < ids.length; i += 90) {
		const chunk = ids.slice(i, i + 90);
		n += (await db
			.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (${chunk.map(() => '?').join(',')})`)
			.bind(...chunk)
			.first<{ n: number }>())!.n;
	}
	return n;
};
describe('NPC camps placed by the rule', () => {
	it('stand where the rule says, the same every time, with nothing stored for those nobody touched', async () => {
		const p = player(rule());
		await p.start();
		const camps = await campsNear(p, 200, 200, 25);
		// About 12 a 16 x 16 block: a 51 x 51 window holds around a hundred.
		expect(camps.length).toBeGreaterThan(50);
		expect(camps.every((c) => /^npc:\d+,\d+,\d+$/.test(c.settlement) && !c.owned)).toBe(true);
		expect(await campsNear(p, 200, 200, 25)).toEqual(camps);
		const ids = camps.map((c) => c.settlement);
		expect(await rowsAbout('npc_camps_state', 'id', ids)).toBe(0);
		expect(await rowsAbout('settlements_settlements', 'id', ids)).toBe(0);
		expect(
			await rowsAbout(
				'world_map_tiles',
				'entity',
				ids.map((id) => `settlement:${id}`),
			),
		).toBe(0);
		// The map shows them like any camp: level, defenders, what a victory brings.
		const c = camps[0];
		const grid = (await p.views(T0, ['world-map.grid'], { x: String(c.x), y: String(c.y), r: '1' }))['world-map.grid'] as GridData;
		const cell = grid.cells.find((x) => x.x === c.x && x.y === c.y)!;
		expect(cell.info!.map((l) => (l.text as { text: string }).text)).toContain('npc-camps.Level {0}');
		// Another seed, another layout.
		const q = player(rule({ seed: 8 }));
		expect((await campsNear(q, 200, 200, 25)).map((x) => x.settlement)).not.toEqual(camps.map((x) => x.settlement));
	});

	it("never stand within a capital's 3 x 3 (cities get no such shelter), and nobody founds on one", async () => {
		const dense = rule({ perBlock: 40 });
		const p = player(dense);
		const c = await p.start();
		const near = await campsNear(p, c.x, c.y, 6);
		expect(near.length).toBeGreaterThan(5);
		expect(near.filter((t) => ring(t, c) <= 1)).toEqual([]);
		// A city may stand right next to one; a camp's own tile is taken.
		const camp = (await campsNear(p, c.x + 60, c.y, 6))[0];
		// Refused as taken, or (camps this dense) for want of free land around it first: either way nobody founds there.
		await expect(p.run(T0, 'settlements.found', { kind: 'city', x: camp.x, y: camp.y }, true)).rejects.toThrow(/occupied|free land/);
		expect((await campsNear(p, camp.x, camp.y, 0)).map((t) => `${t.x},${t.y}`)).toEqual([`${camp.x},${camp.y}`]);
	});

	it('a raid stores one row; uprooting records it gone and the background task replaces it with a stored camp elsewhere', async () => {
		const p = player({ ...rule(), ...easy });
		await p.start();
		// A city of ours next to a rule camp (its land, so the camp can be uprooted from there).
		const camps = await campsNear(p, 300, 300, 10);
		const taken = new Set(camps.map((t) => `${t.x},${t.y}`));
		let city: string | null = null;
		let camp: MapTile | null = null;
		for (const cand of camps) {
			for (const [dx, dy] of [
				[1, 0],
				[-1, 0],
				[0, 1],
				[0, -1],
			]) {
				const at = { x: wrap(cand.x + dx), y: wrap(cand.y + dy) };
				if (taken.has(`${at.x},${at.y}`)) continue;
				try {
					await p.run(T0, 'settlements.found', { kind: 'city', ...at, name: 'Edge' }, true);
				} catch {
					continue;
				}
				city = (await db
					.prepare("SELECT id FROM settlements_settlements WHERE owner_id = ? AND kind = 'city'")
					.bind(p.id)
					.first<{ id: string }>())!.id;
				camp = cand;
				break;
			}
			if (city) break;
		}
		expect(city).not.toBeNull();
		await p.run(T0, 'troops.grant', { settlement: city!, unit: 'cavalry-2', count: 500 }, true);
		const state = () =>
			db
				.prepare('SELECT raided_at, removed FROM npc_camps_state WHERE id = ?')
				.bind(camp!.settlement)
				.first<{ raided_at: number | null; removed: number }>();

		// A raid (only some lanes won is enough for a victory): one row, its time.
		await p.run(T0, 'armies.send', { from: city!, x: camp!.x, y: camp!.y, units: { 'cavalry-2': 100 } });
		await p.run(T0 + 1_500, 'armies.sync');
		const raid = ((await p.views(T0 + 1_500, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		expect(raid.report).toMatchObject({ outcome: 'victory', target: { kind: camp!.kind } });
		expect(await state()).toEqual({ raided_at: T0 + 1_000, removed: 0 });

		// Uprooted: gone (the row says so), the tile free, a stored camp queued to replace it elsewhere.
		const queued = async () => (await db.prepare('SELECT COUNT(*) AS n FROM npc_camps_respawn').first<{ n: number }>())!.n;
		const before = await queued();
		await p.run(T0 + 5_000, 'npc-camps.uproot', { from: city!, x: camp!.x, y: camp!.y, units: { 'cavalry-2': 300 } });
		await p.run(T0 + 6_500, 'armies.sync');
		const reports = ((await p.views(T0 + 6_500, ['armies.list']))['armies.list'] as ArmyInfo[]).map((a) => a.report);
		expect(reports.map((r) => r?.note?.text)).toContain('npc-camps.Uprooted: the land is free');
		expect((await state())!.removed).toBe(1);
		expect((await campsNear(p, camp!.x, camp!.y, 0)).length).toBe(0);
		expect(await queued()).toBe(before + 1);
		const placed = async () => (await db.prepare('SELECT COUNT(*) AS n FROM npc_camps_levels WHERE starter = 0').first<{ n: number }>())!.n;
		const had = await placed();
		await p.run(T0 + 7_000, 'npc-camps.respawn', null, true);
		expect(await placed()).toBe(had + 1);
	});

	it('gives way to a camp the GM places on its tile (gone, not replaced elsewhere); the count report adds up', async () => {
		const p = player(rule());
		await p.start();
		const camp = (await campsNear(p, -300, -300, 8))[0];
		const queued = async () => (await db.prepare('SELECT COUNT(*) AS n FROM npc_camps_respawn').first<{ n: number }>())!.n;
		const before = await queued();
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-fortress', x: camp.x, y: camp.y, level: 4 }, true);
		const now = (await p.tiles(T0, camp.x, camp.y, 0))[0];
		expect(now.settlement).not.toBe(camp.settlement); // a stored camp now
		expect(
			(await db.prepare('SELECT removed FROM npc_camps_state WHERE id = ?').bind(camp.settlement).first<{ removed: number }>())!.removed,
		).toBe(1);
		expect(await queued()).toBe(before);
		const [count] = (await runReport(
			defaultKernel,
			db,
			engineContext(defaultKernel, p.id, T0, p.overrides, true),
			'npc-camps.count',
			{},
		)) as {
			rule: number;
			gone: number;
			placed: number;
		}[];
		// 64 x 64 blocks of 12: every one the rule places, worked out without reading a camp.
		expect(count.rule).toBe(64 * 64 * 12);
		expect(count.gone).toBeGreaterThanOrEqual(1);
		expect(count.placed).toBeGreaterThanOrEqual(1);
	});
});
