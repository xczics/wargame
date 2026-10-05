// What the minute's cron costs per offline player (user 2026-10-05: reads and writes should be at most one row per
// settlement: only resources change while nobody plays). Each task runs with a database counting D1's rows read and
// written; the same minute with one more offline player shows that player's share.
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createKernel, engineContext, executeCommand, type Kernel } from '../src/kernel';
import { plugins } from '../src/plugins';

interface Count {
	read: number;
	written: number;
	statements: number;
}

function counting(db: D1Database, count: Count): D1Database {
	const add = (meta: D1Meta | undefined) => {
		count.read += meta?.rows_read ?? 0;
		count.written += meta?.rows_written ?? 0;
		count.statements++;
	};
	const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
		new Proxy(s, {
			get(target, prop) {
				if (prop === 'bind') return (...args: unknown[]) => wrap(target.bind(...args));
				if (prop === 'all' || prop === 'run')
					return async () => {
						const r = await target[prop]();
						add(r.meta);
						return r;
					};
				if (prop === 'first')
					return async (col?: string) => {
						const r = await target.all();
						add(r.meta);
						const row = (r.results[0] ?? null) as Record<string, unknown> | null;
						return col ? (row?.[col] ?? null) : row;
					};
				if (prop === 'raw') return (target.raw as (...a: unknown[]) => unknown).bind(target);
				return Reflect.get(target, prop);
			},
		});
	return new Proxy(db, {
		get(target, prop) {
			if (prop === 'prepare') return (sql: string) => wrap(target.prepare(sql));
			if (prop === 'batch')
				return async (list: D1PreparedStatement[]) => {
					const unwrapped = list.map((s) => (s as unknown as { __target?: D1PreparedStatement }).__target ?? s);
					const results = await target.batch(unwrapped);
					for (const r of results) add(r.meta);
					return results;
				};
			return Reflect.get(target, prop);
		},
	});
}

async function minute(kernel: Kernel, now: number) {
	const byTask: Record<string, Count> = {};
	for (const task of kernel.tasks.values()) {
		const count = (byTask[task.id] = { read: 0, written: 0, statements: 0 });
		await task.run({ kernel, env: { ...env, DB: counting(env.DB, count) }, now });
	}
	return byTask;
}

const total = (by: Record<string, Count>) =>
	Object.values(by).reduce((a, c) => ({ read: a.read + c.read, written: a.written + c.written, statements: a.statements + c.statements }), {
		read: 0,
		written: 0,
		statements: 0,
	});

describe('cron cost of offline players', () => {
	it('an offline player costs at most a row read a minute once the world is seeded, and no writes', async () => {
		// A coarse world (few, large blocks): seeded in a few minutes, so the test is quick; what follows is the same.
		await env.DB.prepare(
			'INSERT INTO gm_config (key, value, updated_at, updated_by) VALUES (?, ?, 0, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
		)
			.bind('npc-camps.density', JSON.stringify({ blockSize: 128, perBlock: 3, spread: 0 }), 'test')
			.run();
		const kernel = createKernel(plugins);
		const start = Date.now();
		const join = async () => {
			const id = crypto.randomUUID();
			await executeCommand(kernel, env.DB, engineContext(kernel, id, start), 'settlements.foundCapital', null);
			return id;
		};
		await join();
		// Let the world settle first (NPC camps seeded over its first couple of hours): the world's, not a player's.
		let m = 0;
		const quiet = async () => {
			for (let i = 0; i < 400; i++) if (total(await minute(kernel, start + ++m * 60_000)).written === 0) return;
			throw new Error('the cron never went quiet');
		};
		await quiet();
		const one = await minute(kernel, start + ++m * 60_000);
		await join();
		await quiet();
		const two = await minute(kernel, start + ++m * 60_000);
		const a = total(one);
		const b = total(two);
		const share = { read: b.read - a.read, written: b.written - a.written };
		// Measured 2026-10-05: the quiet world 14 rows read and none written a minute; an offline player one more read
		// (the timeline sweep's), no write: production is worked out when someone looks, never written by the cron.
		expect(a.written).toBe(0);
		expect(share.read).toBeLessThanOrEqual(1);
		expect(share.written).toBe(0);
	}, 60_000);
});
