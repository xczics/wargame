/**
 * Worker entry. Deliberately dumb: boots the kernel and dispatches to routes that
 * plugins registered. The built Vue client is served by Workers Assets before
 * this runs (only /api/* reaches the Worker, see `run_worker_first` in wrangler.jsonc).
 */
import { matchRoute, packReads } from './kernel';
import { errorResponse, json } from './lib/http';
import { getKernel } from './runtime/kernel-instance';
import { flushUsage, meterRequest, usageRoute, withUsageRows } from './runtime/usage';

const packed = (env: Env): Env => ({ ...env, DB: packReads(env.DB) });

export default {
	async fetch(request, rawEnv, exec): Promise<Response> {
		const kernel = getKernel();
		const url = new URL(request.url);
		// The usage log (local runs with the option on only): the CPU report, then counting this request.
		const usage = await usageRoute(request, rawEnv, url);
		if (usage) return usage;
		// Reads issued together go to D1 together (src/kernel/pack.ts): one call per round, not one per query.
		const metered = meterRequest(rawEnv, url);
		const env = packed(metered);
		// Gates first (e.g. the usage guard pausing the game near a paid limit): one may answer instead of the routes.
		for (const gate of kernel.gates) {
			const held = await gate.check({ kernel, env, request, url }).catch((err) => (console.error(`Gate ${gate.id} failed`, err), null));
			if (held) return withUsageRows(metered, held);
		}
		const match = matchRoute(kernel, request.method, url.pathname);
		if (!match) {
			return json({ error: { code: 'not_found', message: `No route for ${request.method} ${url.pathname}` } }, { status: 404 });
		}
		try {
			return withUsageRows(
				metered,
				await match.route.handler({ kernel, request, env, exec, params: match.params, url, services: kernel.services }),
			);
		} catch (err) {
			return errorResponse(err);
		}
	},
	/** Cron trigger: run every plugin task; one failing task never stops the others. */
	async scheduled(controller, rawEnv) {
		const kernel = getKernel();
		// A cron run is an invocation too: counted, its rows as well.
		const env = packed(meterRequest(rawEnv, new URL('http://cron/')));
		// A closed gate holds the background tasks too, all but those that must run (e.g. the one that opens it again).
		const closed = (
			await Promise.all(kernel.gates.map((g) => g.closed?.({ kernel, env, now: controller.scheduledTime }).catch(() => false) ?? false))
		).some(Boolean);
		for (const task of kernel.tasks.values()) {
			if (closed && !task.always) continue;
			try {
				await task.run({ kernel, env, now: controller.scheduledTime });
			} catch (err) {
				console.error(`Task ${task.id} failed`, err);
			}
		}
		await flushUsage(rawEnv, controller.scheduledTime).catch((err) => console.error('Usage log failed', err));
	},
} satisfies ExportedHandler<Env>;
