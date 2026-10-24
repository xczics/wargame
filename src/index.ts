/**
 * Worker entry. Deliberately dumb: boots the kernel and dispatches to routes that
 * plugins registered. The built Vue client is served by Workers Assets before
 * this runs (only /api/* reaches the Worker, see `run_worker_first` in wrangler.jsonc).
 */
import { matchRoute, packReads } from './kernel';
import { errorResponse, json } from './lib/http';
import { getKernel } from './runtime/kernel-instance';
import { runTasks } from './runtime/tasks';
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
	/** Cron trigger (every minute): the tasks due and with work (src/runtime/tasks.ts). */
	async scheduled(controller, rawEnv) {
		const kernel = getKernel();
		// A cron run is an invocation too: counted, its rows as well.
		await runTasks(kernel, packed(meterRequest(rawEnv, new URL('http://cron/'))), controller.scheduledTime);
		await flushUsage(rawEnv, controller.scheduledTime).catch((err) => console.error('Usage log failed', err));
	},
} satisfies ExportedHandler<Env>;
