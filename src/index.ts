/**
 * Worker entry. Deliberately dumb: boots the kernel and dispatches to routes that
 * plugins registered. The built Vue client is served by Workers Assets before
 * this runs (only /api/* reaches the Worker, see `run_worker_first` in wrangler.jsonc).
 */
import { matchRoute } from './kernel';
import { errorResponse, json } from './lib/http';
import { getKernel } from './runtime/kernel-instance';

export default {
	async fetch(request, env, exec): Promise<Response> {
		const kernel = getKernel();
		const url = new URL(request.url);
		const match = matchRoute(kernel, request.method, url.pathname);
		if (!match) {
			return json({ error: { code: 'not_found', message: `No route for ${request.method} ${url.pathname}` } }, { status: 404 });
		}
		try {
			return await match.route.handler({ kernel, request, env, exec, params: match.params, url, services: kernel.services });
		} catch (err) {
			return errorResponse(err);
		}
	},
	/** Cron trigger: run every plugin task; one failing task never stops the others. */
	async scheduled(controller, env) {
		const kernel = getKernel();
		for (const task of kernel.tasks.values()) {
			try {
				await task.run({ kernel, env, now: controller.scheduledTime });
			} catch (err) {
				console.error(`Task ${task.id} failed`, err);
			}
		}
	},
} satisfies ExportedHandler<Env>;
