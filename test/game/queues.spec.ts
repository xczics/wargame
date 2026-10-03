/** Queues: jobs waiting their turn at a settlement (training, the wall). */
import { describe, expect, it } from 'vitest';
import type { SiegeWall } from '../../src/shared/api';
import { db, T0, player } from '../helpers';

const wallOf = async (p: ReturnType<typeof player>, now: number, settlement: string) =>
	(await p.views(now, ['starter-siege.wall'], { settlement }))['starter-siege.wall'] as SiegeWall;

describe('queues', () => {
	it('lets as many wait in a line as queues.waiting allows; the running job does not count', async () => {
		const p = player({ 'queues.maxWaiting': 1, 'starter-siege.wallSpeed': 0 });
		const c = await p.start();
		for (const r of ['stone', 'wood', 'metal', 'gold']) await p.grant(T0, r, 50_000);
		const build = () => p.run(T0, 'starter-siege.build', { settlement: c.id, device: 'rock-drop', count: 1 });
		await build(); // runs
		await build(); // waits
		await expect(build()).rejects.toMatchObject({ code: 'queue_full', text: { text: 'queues.At most {0} waiting here', vars: { 0: 1 } } });
	});

	it('builds queued wall works one level after another', async () => {
		const p = player({ 'starter-siege.wallSpeed': 0 });
		const c = await p.start();
		for (const r of ['stone', 'wood', 'metal', 'gold', 'food']) await p.grant(T0, r, 500_000);
		await p.run(T0, 'starter-siege.fortify', { settlement: c.id, work: 'moat' });
		await p.run(T0, 'starter-siege.fortify', { settlement: c.id, work: 'moat' });
		const wall = await wallOf(p, T0, c.id);
		expect(wall.queue).toMatchObject({ item: 'moat', amount: 1 });
		expect(wall.waiting).toEqual([expect.objectContaining({ item: 'moat', amount: 2 })]);
		// Long after: both done, level 2.
		expect((await wallOf(p, T0 + 30 * 86_400_000, c.id)).works.find((w) => w.id === 'moat')?.level).toBe(2);
	});

	it('takes over a wall job kept before the queues plugin', async () => {
		const p = player();
		const c = await p.start();
		await db.batch([
			db
				.prepare('INSERT INTO starter_siege_queue (settlement_id, kind, item, amount, started_at, finishes_at) VALUES (?, ?, ?, ?, ?, ?)')
				.bind(c.id, 'device', 'rock-drop', 3, T0, T0 + 90_000),
			db
				.prepare('INSERT INTO timeline_events (id, entity, due_at, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
				.bind(crypto.randomUUID(), `settlement:${c.id}`, T0 + 90_000, 'starter-siege.done', JSON.stringify({ settlementId: c.id }), T0),
		]);
		expect((await wallOf(p, T0 + 1_000, c.id)).queue).toMatchObject({
			kind: 'device',
			item: 'rock-drop',
			amount: 3,
			finishesAt: T0 + 90_000,
		});
		const later = await wallOf(p, T0 + 91_000, c.id);
		expect(later.queue).toBeNull();
		expect(later.devices.find((d) => d.id === 'rock-drop')?.count).toBe(3);
	});
});
