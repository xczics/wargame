/**
 * Public HTTP API for the logged-in player.
 *
 *   GET  /api/meta[/<version>]     static game data contributed by plugins (`ctx.meta.add`); no login needed
 *   GET  /api/state[?views=a,b&...]    the player's views (all, or only the listed ones); other query
 *                                      params go to the views (e.g. settlement=<id>, placement=...)
 *   POST /api/command[?views=a,b&...]  { type, payload } -> run a command, then return fresh views
 */
import {
	computeViews,
	definePlugin,
	type EngineContext,
	executeCommand,
	GameError,
	gameErrors,
	type Kernel,
	loadConfig,
	type PlayerRecord,
	readRecord,
} from '../../kernel';
import { json, readJson } from '../../lib/http';
import { bakedMetaVersion, buildMeta, type MetaFile } from '../../runtime/meta';
import { requestContext, requestedInstances, requestedStamps, requestedViews, viewParams } from '../../runtime/context';
import { staticBody, staticsList, staticVersions } from '../../runtime/statics';
import type { ClientState } from '../../shared/api';
import i18nCsv from './data/i18n.csv?raw';

const fail = gameErrors('http-api');

/** The meta's body and version, built once per isolate (it depends only on the deploy). */
const metas = new WeakMap<Kernel, Promise<MetaFile>>();
function metaOf(kernel: Kernel) {
	let m = metas.get(kernel);
	if (!m) metas.set(kernel, (m = buildMeta(kernel)));
	return m;
}
/** Its version alone, for every state and command: baked by the build, so an isolate never works the meta out for it. */
const metaVersion = async (kernel: Kernel) => bakedMetaVersion ?? (await metaOf(kernel)).version;

/** The FILES bucket's public URL, when the deployment gives one: browsers fetch the files from there. */
const filesBase = (env: Env) => {
	const base = (env.FILES_BASE_URL as string | undefined)?.replace(/\/+$/, '');
	return base ? { filesBase: base } : {};
};

/**
 * What a state or command answer adds to the views (user 2026-10-24: "它难道不该只回复一个'已读标记成功'吗？"): the
 * stamps once keyed (`stampKey`), a left-out view's empty; the static views' versions only when not the client's (`sv`).
 */
async function answerOf(kernel: Kernel, env: Env, context: EngineContext, url: URL, state: ClientState): Promise<ClientState> {
	const key = Object.values({ ...state.stamps, ...state.instanceStamps })[0]?.split('~')[0];
	const compact = (list: Record<string, string> | undefined, sent: Record<string, unknown> | undefined) =>
		list && key !== undefined
			? Object.fromEntries(Object.entries(list).map(([id, s]) => [id, sent && id in sent ? s.slice(s.indexOf('~') + 1) : '']))
			: list;
	const statics = await staticsList(kernel, env, { values: context.config, version: context.rulesVersion ?? 0 });
	return {
		...state,
		...(key !== undefined ? { stampKey: key } : {}),
		...(state.stamps ? { stamps: compact(state.stamps, state.views) } : {}),
		...(state.instanceStamps ? { instanceStamps: compact(state.instanceStamps, state.instances) } : {}),
		player: context.playerId,
		...(url.searchParams.get('sv') === statics.version ? {} : { statics: statics.versions }),
		staticsVersion: statics.version,
		metaVersion: await metaVersion(kernel),
		...filesBase(env),
	};
}

/**
 * Who asks and under which rules, found together: the session's row and the rules' version are read at once (in one
 * round trip with the request's other first reads: src/kernel/pack.ts), not one after the other. With `sync` (the
 * player the client says it is, `ClientState.player`), that player's record too (`readRecord`): an unchanged sync is
 * answered from these alone. Theirs only if the session says so.
 */
async function playerContext(
	kernel: Kernel,
	env: Env,
	request: Request,
	services: Kernel['services'],
	sync?: string | null,
): Promise<{ context: EngineContext; record: Promise<PlayerRecord> | 'read' }> {
	const session = services.get('session').resolve(request, env);
	const rules = requestContext(kernel, env, '');
	const record = sync && sync.length <= 64 ? readRecord(kernel, env.DB, sync, Date.now()) : null;
	// Not asked for when the session fails: no unhandled rejection of the others.
	rules.catch(() => {});
	record?.catch(() => {});
	const { playerId, gm } = await session;
	return { context: { ...(await rules), playerId, gmViewer: gm }, record: record && sync === playerId ? record : 'read' };
}

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
				const { context, record } = await playerContext(kernel, env, request, services, url.searchParams.get('sync'));
				const state = await computeViews(
					kernel,
					env.DB,
					context,
					requestedViews(url),
					viewParams(url),
					requestedInstances(url),
					undefined,
					requestedStamps(url),
					record,
				);
				return json(await answerOf(kernel, env, context, url, state));
			},
		});

		// A baked static view by version (it never changes under its version: kept by browsers for good).
		ctx.routes.add({
			method: 'GET',
			path: '/api/static/:id/:version',
			async handler({ kernel, env, params }) {
				let body = await staticBody(kernel, env, params.id, params.version);
				if (body === null) {
					// This isolate may not have baked yet (a cold start with the memory store).
					await staticVersions(kernel, env, await loadConfig(kernel, env));
					body = await staticBody(kernel, env, params.id, params.version);
				}
				if (body === null) return json({ error: { code: 'not_found', message: 'No such static view version' } }, { status: 404 });
				return new Response(body, {
					headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=31536000, immutable' },
				});
			},
		});

		// A player's command, answered with the views of the page that sent it (what the command changed only).
		ctx.routes.add({
			method: 'POST',
			path: '/api/command',
			async handler({ kernel, request, env, url, services }) {
				// The body read while the session and the rules are (a bad session still answers first: 401).
				const reading = readJson(request);
				reading.catch(() => {});
				const { context } = await playerContext(kernel, env, request, services);
				const body = await reading;
				if (typeof body !== 'object' || body === null || typeof (body as { type?: unknown }).type !== 'string') {
					throw fail('bad_command', 'Body must be { type: string, payload?: unknown }');
				}
				const { type, payload } = body as { type: string; payload?: unknown };
				const { carried, committed } = await executeCommand(kernel, env.DB, context, type, payload ?? null).catch((err) => {
					// A refused command reached the server: the browser could have refused it (docs/workers-performance.md:
					// legal commands take the fast path, the browser stops the rest). Logged by type and code only.
					if (err instanceof GameError) console.warn(`[refused] ${type} ${err.code}`);
					throw err;
				});
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
					'read',
					committed,
				);
				return json(await answerOf(kernel, env, context, url, state));
			},
		});
	},
});
