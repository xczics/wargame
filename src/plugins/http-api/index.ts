/**
 * Public HTTP API for the logged-in player.
 *
 *   GET  /api/meta[/<version>]     static game data contributed by plugins (`ctx.meta.add`); no login needed
 *   GET  /api/state[?views=a,b&...]    the player's views (all, or only the listed ones); other query
 *                                      params go to the views (e.g. settlement=<id>, placement=...)
 *   POST /api/command[?views=a,b&...]  { type, payload } -> run a command, then return fresh views
 */
import { computeViews, definePlugin, type EngineContext, executeCommand, gameErrors, type Kernel, loadConfig } from '../../kernel';
import { json, readJson } from '../../lib/http';
import { requestContext, requestedInstances, requestedStamps, requestedViews, viewParams } from '../../runtime/context';
import { staticBody, staticVersions } from '../../runtime/statics';
import type { ClientState } from '../../shared/api';
import i18nCsv from './data/i18n.csv?raw';

const fail = gameErrors('http-api');

/** The meta's body and version, built once per isolate (it depends only on the deploy). */
const metas = new WeakMap<Kernel, Promise<{ body: string; version: string }>>();
function metaOf(kernel: Kernel) {
	let m = metas.get(kernel);
	if (!m) {
		m = (async () => {
			const meta: Record<string, unknown> = {};
			for (const [key, provider] of kernel.meta) meta[key] = provider();
			const body = JSON.stringify({
				plugins: kernel.plugins.map((p) => ({ id: p.id, version: p.version, description: p.description })),
				...meta,
			});
			const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
			return { body, version: [...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('') };
		})();
		metas.set(kernel, m);
	}
	return m;
}

/** The static views' versions under this request's rules (from what this isolate baked; baking only on a change). */
const staticsOf = (kernel: Kernel, env: Env, context: EngineContext) =>
	staticVersions(kernel, env, { values: context.config, version: context.rulesVersion ?? 0 });

export default definePlugin({
	id: 'http-api',
	version: '0.3.0',
	description: 'JSON API: /api/meta, /api/state, /api/command',
	dependsOn: ['accounts', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		// The meta depends only on the deploy (content and code): served by version, kept by browsers for good, so a
		// page load asks the Worker for it only when the version it holds is not the current one (user 2026-10-05:
		// Workers requests are what the free plan counts).
		const metaHeaders = (version: string) => ({ 'content-type': 'application/json; charset=utf-8', 'x-meta-version': version });
		ctx.routes.add({
			method: 'GET',
			path: '/api/meta',
			async handler({ kernel }) {
				const { body, version } = await metaOf(kernel);
				return new Response(body, { headers: { ...metaHeaders(version), 'cache-control': 'no-cache' } });
			},
		});
		ctx.routes.add({
			method: 'GET',
			path: '/api/meta/:version',
			async handler({ kernel, params }) {
				const { body, version } = await metaOf(kernel);
				// An old version (a deploy since): the current one, not to be kept under the old address.
				const cache = params.version === version ? 'public, max-age=31536000, immutable' : 'no-store';
				return new Response(body, { headers: { ...metaHeaders(version), 'cache-control': cache } });
			},
		});

		ctx.routes.add({
			method: 'GET',
			path: '/api/state',
			async handler({ kernel, request, env, url, services }) {
				const { playerId, gm } = await services.get('session').resolve(request, env);
				const context = await requestContext(kernel, env, playerId, false, gm);
				const state = await computeViews(
					kernel,
					env.DB,
					context,
					requestedViews(url),
					viewParams(url),
					requestedInstances(url),
					undefined,
					requestedStamps(url),
				);
				return json({
					...state,
					statics: await staticsOf(kernel, env, context),
					metaVersion: (await metaOf(kernel)).version,
				} satisfies ClientState);
			},
		});

		// A baked static view by version (it never changes under its version: kept by browsers for good).
		ctx.routes.add({
			method: 'GET',
			path: '/api/static/:id/:version',
			async handler({ kernel, env, params }) {
				let body = await staticBody(kernel, params.id, params.version);
				if (body === null) {
					// This isolate may not have baked yet (a cold start with the memory store).
					await staticVersions(kernel, env, await loadConfig(kernel, env));
					body = await staticBody(kernel, params.id, params.version);
				}
				if (body === null) return json({ error: { code: 'not_found', message: 'No such static view version' } }, { status: 404 });
				return new Response(body, {
					headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' },
				});
			},
		});

		ctx.routes.add({
			method: 'POST',
			path: '/api/command',
			async handler({ kernel, request, env, url, services }) {
				const { playerId } = await services.get('session').resolve(request, env);
				const body = await readJson(request);
				if (typeof body !== 'object' || body === null || typeof (body as { type?: unknown }).type !== 'string') {
					throw fail('bad_command', 'Body must be { type: string, payload?: unknown }');
				}
				const { type, payload } = body as { type: string; payload?: unknown };
				const gm = !!(await services.get('accounts').current(request, env))?.gm;
				const context = await requestContext(kernel, env, playerId, false, gm);
				const { carried } = await executeCommand(kernel, env.DB, context, type, payload ?? null);
				// The views start from what the command kept current (MemoOptions.current): no second read of it.
				const state = await computeViews(
					kernel,
					env.DB,
					context,
					requestedViews(url),
					viewParams(url),
					requestedInstances(url),
					carried,
					requestedStamps(url),
				);
				return json({
					...state,
					statics: await staticsOf(kernel, env, context),
					metaVersion: (await metaOf(kernel)).version,
				} satisfies ClientState);
			},
		});
	},
});
