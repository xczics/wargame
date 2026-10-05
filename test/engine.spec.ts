/** Unit-of-work semantics of the engine: atomic commits and optimistic-lock retries. */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { computeViews, createKernel, definePlugin, engineContext, executeCommand, GameError, type Kernel } from '../src/kernel';
import { coalesce, recording } from '../src/kernel/coalesce';
import worker from '../src/index';
import { plugins } from '../src/plugins';
import { createScheduledController } from 'cloudflare:test';

const db = env.DB;
const noop = () => db.prepare('SELECT 1');

describe('engine', () => {
	it('retries a command when another commit for the same player lands in between', async () => {
		let attempts = 0;
		const kernel: Kernel = createKernel([
			definePlugin({
				id: 't',
				version: '0',
				setup(c) {
					c.commands.add({ type: 't.inner', parse: () => null, execute: async (api) => api.write(noop()) });
					c.commands.add({
						type: 't.outer',
						parse: () => null,
						async execute(api) {
							attempts++;
							// Simulate a concurrent request committing after we read our lock version.
							if (attempts === 1) await executeCommand(kernel, db, engineContext(kernel, api.playerId, api.now), 't.inner', null);
							api.write(noop());
						},
					});
				},
			}),
		]);
		const ctx = engineContext(kernel, crypto.randomUUID(), 0);
		await executeCommand(kernel, db, ctx, 't.outer', null);
		expect(attempts).toBe(2);
	});

	it('api.version: how many commits locked an entity, the same until the next one (a view stamp)', async () => {
		const seen: number[] = [];
		const kernel: Kernel = createKernel([
			definePlugin({
				id: 't',
				version: '0',
				setup(c) {
					c.commands.add({ type: 't.write', parse: () => null, execute: async (api) => api.write(noop()) });
					c.commands.add({ type: 't.read', parse: () => null, execute: async () => {} });
					c.views.add({ id: 't.version', compute: async (api) => void seen.push(await api.version(`player:${api.playerId}`)) });
				},
			}),
		]);
		const ctx = engineContext(kernel, crypto.randomUUID(), 0);
		const look = () => computeViews(kernel, db, ctx, ['t.version'], {});
		await look();
		await executeCommand(kernel, db, ctx, 't.write', null);
		await look();
		await executeCommand(kernel, db, ctx, 't.read', null); // writes nothing: no commit
		await look();
		expect(seen).toEqual([0, 1, 1]);
	});

	it('a stamp holds only under the same parameters', async () => {
		let computed = 0;
		const kernel: Kernel = createKernel([
			definePlugin({
				id: 't',
				version: '0',
				setup(c) {
					c.views.add({ id: 't.stamped', stamp: async () => 'same', compute: async () => ++computed });
				},
			}),
		]);
		const ctx = engineContext(kernel, crypto.randomUUID(), 0);
		const first = await computeViews(kernel, db, ctx, ['t.stamped'], { hero: 'a' });
		const held = first.stamps!;
		expect((await computeViews(kernel, db, ctx, ['t.stamped'], { hero: 'a' }, [], undefined, held)).views).toEqual({});
		expect((await computeViews(kernel, db, ctx, ['t.stamped'], { hero: 'b' }, [], undefined, held)).views).toEqual({ 't.stamped': 2 });
	});

	it('commits all writes or none', async () => {
		const id = crypto.randomUUID();
		const kernel = createKernel([
			definePlugin({
				id: 't',
				version: '0',
				setup(c) {
					c.commands.add({
						type: 't.half',
						parse: () => null,
						async execute(api) {
							api.write(
								db
									.prepare('INSERT INTO buildings_slots (district_id, slot, settlement_id, building, level) VALUES (?, 0, ?, ?, 1)')
									.bind(id, id, 'x'),
							);
							api.write(
								db
									.prepare('INSERT INTO buildings_slots (district_id, slot, settlement_id, building, level) VALUES (?, 1, ?, ?, -1)')
									.bind(id, id, 'y'),
							); // violates CHECK
						},
					});
					c.commands.add({
						type: 't.reject',
						parse: () => null,
						execute: async () => {
							throw new GameError('nope', 'no');
						},
					});
				},
			}),
		]);
		await expect(executeCommand(kernel, db, engineContext(kernel, id, 0), 't.half', null)).rejects.toThrow();
		const row = await db.prepare('SELECT COUNT(*) AS n FROM buildings_slots WHERE settlement_id = ?').bind(id).first<{ n: number }>();
		expect(row?.n).toBe(0);
		await expect(executeCommand(kernel, db, engineContext(kernel, id, 0), 't.reject', null)).rejects.toThrow(GameError);
	});

	it('the cron sweep processes due events nobody looked at', async () => {
		const kernel = createKernel(plugins);
		const id = crypto.randomUUID();
		const past = Date.now() - 60_000; // a build started a minute ago finished 50 s ago
		const ctx = (now: number) => engineContext(kernel, id, now);
		await executeCommand(kernel, db, ctx(past), 'settlements.foundCapital', null);
		const s = await db.prepare('SELECT id FROM settlements_settlements WHERE owner_id = ?').bind(id).first<{ id: string }>();
		const d = await db
			.prepare("SELECT id FROM settlements_districts WHERE settlement_id = ? AND type = 'outer'")
			.bind(s!.id)
			.first<{ id: string }>();
		await executeCommand(kernel, db, ctx(past), 'buildings.construct', { settlement: s!.id, district: d!.id, slot: 0, building: 'farm' });

		await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '* * * * *' }), env);
		const slot = await db.prepare('SELECT level FROM buildings_slots WHERE district_id = ?').bind(d!.id).first<{ level: number }>();
		expect(slot?.level).toBe(1);
		const pending = await db
			.prepare('SELECT COUNT(*) AS n FROM timeline_events WHERE entity = ?')
			.bind(`settlement:${s!.id}`)
			.first<{ n: number }>();
		expect(pending?.n).toBe(0);
	});

	it('the NPC upkeep task seeds a world short of camps, then stays quiet once the pass is done', async () => {
		const count = async () => (await db.prepare('SELECT COUNT(*) AS n FROM npc_camps_levels').first<{ n: number }>())!.n;
		const before = await count();
		// Four blocks, all in one step; each should hold more than the whole world has now.
		const perBlock = before + 2;
		const set = (key: string, value: unknown) =>
			db
				.prepare(
					'INSERT INTO gm_config (key, value, updated_at, updated_by) VALUES (?, ?, 0, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
				)
				.bind(key, JSON.stringify(value), 'test')
				.run();
		await set('npc-camps.density', { blockSize: 512, perBlock, spread: 0 });
		await set('npc-camps.seedBlocks', 4);
		await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '* * * * *' }), env);
		const after = await count();
		expect(after).toBeGreaterThanOrEqual(4 * perBlock);
		await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '* * * * *' }), env);
		expect(await count()).toBe(after); // the pass is done
		await db.prepare("DELETE FROM gm_config WHERE key IN ('npc-camps.density', 'npc-camps.seedBlocks')").run();
	});
});

describe('coalescing writes', () => {
	it('merges single-row inserts into one table, keeps each table in order, fits the parameter limit', async () => {
		await db.prepare('CREATE TABLE IF NOT EXISTS coalesce_t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)').run();
		await db.prepare('CREATE TABLE IF NOT EXISTS coalesce_u (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)').run();
		const r = recording(db);
		const ins = (t: string, id: number, v: number) => r.prepare(`INSERT INTO ${t} (id, v) VALUES (?, ?)`).bind(id, v);
		const upsert = (id: number, v: number) =>
			r.prepare('INSERT INTO coalesce_t (id, v) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET v = excluded.v').bind(id, v);
		const list = [
			...Array.from({ length: 60 }, (_, i) => ins('coalesce_t', 1000 + i, i)), // 120 parameters: two statements
			ins('coalesce_u', 1, 1), // another table: does not stop the run
			ins('coalesce_t', 2000, 1),
			r.prepare('UPDATE coalesce_t SET v = v + 100 WHERE id = 2000'), // its table: later inserts stay after it
			ins('coalesce_t', 2001, 1),
			upsert(2001, 7), // other SQL (ON CONFLICT): its own statement, after the insert it updates
		];
		const out = coalesce(r, list);
		expect(out).toHaveLength(6);
		await db.batch(out);
		const rows = await db.prepare('SELECT id, v FROM coalesce_t WHERE id >= 2000 ORDER BY id').all();
		expect(rows.results).toEqual([
			{ id: 2000, v: 101 },
			{ id: 2001, v: 7 },
		]);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM coalesce_t WHERE id BETWEEN 1000 AND 1059').first<{ n: number }>())!.n).toBe(60);
		// Statements not made through `recording` stay put and close every run.
		expect(coalesce(r, [ins('coalesce_t', 3000, 1), db.prepare('SELECT 1'), ins('coalesce_t', 3001, 1)])).toHaveLength(3);
	});
});
