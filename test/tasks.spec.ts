/**
 * The cron's background tasks (src/runtime/tasks.ts): by the minute (`every`), and only those whose probe finds work,
 * the probes all in one batch.
 */
import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { createKernel, definePlugin } from '../src/kernel';
import { runTasks } from '../src/runtime/tasks';

describe('background tasks', () => {
	it('run when their minute comes and their probe finds work; null probes and empty answers skip them', async () => {
		const ran: string[] = [];
		const calls: number[] = [];
		const db = new Proxy(env.DB, {
			get(t, k) {
				if (k === 'batch') return (list: D1PreparedStatement[]) => (calls.push(list.length), t.batch(list));
				const v = Reflect.get(t, k, t);
				return typeof v === 'function' ? v.bind(t) : v;
			},
		});
		const kernel = createKernel([
			definePlugin({
				id: 'tasks-test',
				version: '0.0.1',
				setup(ctx) {
					const task = (id: string, extra: object) => ctx.tasks.add({ id, run: async () => void ran.push(id), ...extra });
					task('tasks-test.always', {});
					task('tasks-test.work', { probe: (e: Env) => e.DB.prepare('SELECT 1') });
					task('tasks-test.idle', { probe: (e: Env) => e.DB.prepare('SELECT 1 WHERE 0') });
					task('tasks-test.off', { probe: () => null });
					task('tasks-test.hourly', { every: 60 });
				},
			}),
		]);
		const e = { ...env, DB: db } as Env;
		expect(await runTasks(kernel, e, 60 * 60_000 * 1000 + 5 * 60_000)).toEqual(['tasks-test.always', 'tasks-test.work']);
		expect(calls).toEqual([2]); // the two probes, one batch
		expect(await runTasks(kernel, e, 60 * 60_000 * 1000)).toEqual(['tasks-test.always', 'tasks-test.work', 'tasks-test.hourly']);
	});

	it('a task keyed with "rules | build" has work only when its mark is not that', async () => {
		const kernel = createKernel([]);
		await env.DB.prepare('CREATE TABLE IF NOT EXISTS tasks_test_mark (value TEXT)').run();
		await env.DB.prepare('DELETE FROM tasks_test_mark').run();
		const probe = (build: string) =>
			env.DB.prepare(`SELECT 1 WHERE coalesce((SELECT value FROM tasks_test_mark), '') <> 0 || '|' || ?`).bind(build);
		expect((await probe('b1').all()).results.length).toBe(1);
		await env.DB.prepare("INSERT INTO tasks_test_mark VALUES ('0|b1')").run();
		expect((await probe('b1').all()).results.length).toBe(0);
		expect((await probe('b2').all()).results.length).toBe(1);
		void kernel;
	});
});
