/**
 * The background tasks of a cron run (every minute): those whose minute it is (`Task.every`) ask whether they have
 * work, all in one batch (`Task.probe`), and only those with some run; one failing task never stops the others. A run
 * with nothing to do is that one batch (user 2026-10-24: the runs cost 10-70 ms of CPU while nobody played, each task
 * reading on its own; docs/workers-performance.md).
 */
import type { Kernel, Task } from '../kernel';

/** Runs what is due; returns the ids of the tasks that ran. */
export async function runTasks(kernel: Kernel, env: Env, now: number): Promise<string[]> {
	const minute = Math.floor(now / 60_000);
	const store = kernel.services.has('configStore') ? kernel.services.get('configStore') : null;
	const context = { now, build: kernel.build, rulesSql: store?.versionSql ? `coalesce(${store.versionSql}, 0)` : '0' };
	const due = [...kernel.tasks.values()].filter((t) => minute % Math.max(1, t.every ?? 1) === 0);
	const probes = due.map((t) => (t.probe ? t.probe(env, context) : undefined));
	const asked = probes.filter((p): p is D1PreparedStatement => !!p);
	const answers = asked.length ? await env.DB.batch(asked) : [];
	const ran: Task[] = [];
	let k = 0;
	for (const [i, task] of due.entries()) {
		const probe = probes[i];
		if (probe === null || (probe && !answers[k++].results.length)) continue;
		ran.push(task);
		try {
			await task.run({ kernel, env, now });
		} catch (err) {
			console.error(`Task ${task.id} failed`, err);
		}
	}
	return ran.map((t) => t.id);
}
