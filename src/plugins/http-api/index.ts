/**
 * Public HTTP API for the logged-in player.
 *
 *   GET  /api/meta                 static game data contributed by plugins (`ctx.meta.add`); no login needed
 *   GET  /api/state[?views=a,b&...]    the player's views (all, or only the listed ones); other query
 *                                      params go to the views (e.g. settlement=<id>, placement=...)
 *   POST /api/command[?views=a,b&...]  { type, payload } -> run a command, then return fresh views
 */
import { computeViews, definePlugin, executeCommand, GameError } from '../../kernel';
import { json, readJson } from '../../lib/http';
import { requestContext, requestedViews, viewParams } from '../../runtime/context';

export default definePlugin({
	id: 'http-api',
	version: '0.3.0',
	description: 'JSON API: /api/meta, /api/state, /api/command',
	dependsOn: ['accounts'],
	setup(ctx) {
		ctx.routes.add({
			method: 'GET',
			path: '/api/meta',
			handler({ kernel }) {
				const meta: Record<string, unknown> = {};
				for (const [key, provider] of kernel.meta) meta[key] = provider();
				return json({
					plugins: kernel.plugins.map((p) => ({ id: p.id, version: p.version, description: p.description })),
					...meta,
				});
			},
		});

		ctx.routes.add({
			method: 'GET',
			path: '/api/state',
			async handler({ kernel, request, env, url, services }) {
				const { playerId, gm } = await services.get('session').resolve(request, env);
				const context = await requestContext(kernel, env, playerId, false, gm);
				return json(await computeViews(kernel, env.DB, context, requestedViews(url), viewParams(url)));
			},
		});

		ctx.routes.add({
			method: 'POST',
			path: '/api/command',
			async handler({ kernel, request, env, url, services }) {
				const { playerId } = await services.get('session').resolve(request, env);
				const body = await readJson(request);
				if (typeof body !== 'object' || body === null || typeof (body as { type?: unknown }).type !== 'string') {
					throw new GameError('bad_command', 'Body must be { type: string, payload?: unknown }');
				}
				const { type, payload } = body as { type: string; payload?: unknown };
				const gm = !!(await services.get('accounts').current(request, env))?.gm;
				const context = await requestContext(kernel, env, playerId, false, gm);
				await executeCommand(kernel, env.DB, context, type, payload ?? null);
				return json(await computeViews(kernel, env.DB, context, requestedViews(url), viewParams(url)));
			},
		});
	},
});
