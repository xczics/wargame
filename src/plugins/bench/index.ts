/**
 * Bench routes (docs/workers-performance.md §4, changelog 440): where a production request's CPU goes, measured with
 * the per-request `cpuTime` that `wrangler tail` reports, one phase per address (a Worker cannot time its own CPU:
 * its clocks stand still between I/O, which `/timers` shows).
 *
 * Off unless the variable `BENCH` is "1" (every address then answers 404 as an unknown one). Every address needs a
 * logged-in player and touches only that player's own rows; none writes anything: a dry run sends no-op statements
 * in place of the writes (`dry.ts`, `raw-construct.ts`).
 *
 *   GET  /api/_bench/timers?n=            clocks around a busy loop of n steps, and after one D1 read
 *   GET  /api/_bench/noop                 nothing (the cost of any request: routing, the session)
 *   GET  /api/_bench/d1?n=&mode=seq|batch|pack   n trivial reads: one call each, one batch, or issued at once (packed)
 *   GET  /api/_bench/assemble[?rules=1]   createKernel inside the request (and the rules worked out on it, GM overrides)
 *   GET  /api/_bench/sync?<as /api/state> the work of /api/state for the same query (`_bench`, `_n`: labels, dropped)
 *   GET  /api/_bench/upgrade              read and parse the rules file of the version before (the first touch after a deploy)
 *   GET  /api/_bench/target               a construct payload for this player (the lowest building not being built)
 *   POST /api/_bench/raw/buildings.construct   that command by hand, no kernel (raw-construct.ts)
 *   POST /api/_bench/real/<command>[?views=…][&flat=0]  the real command through executeCommand (flat=0: its regular
 *     path even where it has a fast one), writes replaced by no-ops,
 *                                               then the views as /api/command (none without `views`)
 */
import pkg from '../../../package.json';
import {
	computeViews,
	createKernel,
	definePlugin,
	type EngineContext,
	executeCommand,
	type Kernel,
	type PlayerRecord,
	readRecord,
	resolveConfig,
	type RouteContext,
} from '../../kernel';
import { json, readJson } from '../../lib/http';
import { requestContext, requestedInstances, requestedStamps, requestedViews, viewParams } from '../../runtime/context';
import { bakedMetaVersion } from '../../runtime/meta';
import { staticVersions } from '../../runtime/statics';
import { dryDatabase } from './dry';
import { type ConstructRules, rawConstruct } from './raw-construct';

const enabled = (env: Env) => (env as { BENCH?: string }).BENCH === '1';
const notFound = (request: Request, url: URL) =>
	json({ error: { code: 'not_found', message: `No route for ${request.method} ${url.pathname}` } }, { status: 404 });
const int = (url: URL, name: string, min: number, max: number, fallback: number) => {
	const n = Math.floor(Number(url.searchParams.get(name) ?? fallback));
	return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * This isolate, and how many /api requests it has served (counted by a gate, while on): the client logs it with each
 * answer, so a request can be told apart as the first of a fresh isolate or a later one. Named on first use (no
 * random values at a module's top level in Workers).
 */
const isolate = { id: '', served: 0 };

/** The construct rules as the content has them (no GM overrides), worked out once per isolate. */
let constructRules: ConstructRules | null = null;
function rulesFor(kernel: Kernel): ConstructRules {
	if (constructRules) return constructRules;
	const v = resolveConfig(kernel, {}).values as Record<string, unknown>;
	constructRules = {
		plans: v['buildings.rules'] as ConstructRules['plans'],
		speed: v['buildings.speed'] as number,
		ownResourceFreeUntil: v['buildings.ownResourceFreeUntil'] as number,
		queueSize: v['buildings.queueSize'] as number,
	};
	return constructRules;
}

export default definePlugin({
	id: 'bench',
	version: '0.1.0',
	description: 'Diagnostics: one address per phase of a request, for measuring CPU in production (off unless BENCH=1)',
	dependsOn: ['accounts'],
	setup(ctx) {
		const session = () => ctx.services.get('session');
		ctx.gates.add({
			id: 'bench.count',
			async check({ env }) {
				if (enabled(env)) isolate.served++;
				return null;
			},
		});
		/**
		 * A bench address: off → 404; otherwise the player first (401 / 403 as anywhere), then the work. `start`: reads
		 * issued together with the session's (as /api/state and /api/command do: one round trip), handed to `fn`.
		 */
		const add = <S = undefined>(
			method: 'GET' | 'POST',
			path: string,
			fn: (a: RouteContext, playerId: string, started: S) => Promise<unknown>,
			start?: (a: RouteContext) => S,
		) =>
			ctx.routes.add({
				method,
				path,
				async handler(a) {
					if (!enabled(a.env)) return notFound(a.request, a.url);
					// A label for grouping in the logs (scripts/bench-online.mjs), not a view parameter.
					a.url.searchParams.delete('_bench');
					a.url.searchParams.delete('_n');
					const t0 = performance.now();
					const who = session().resolve(a.request, a.env);
					const started = start?.(a) as S;
					// Not waited for when the session fails: no unhandled rejection.
					for (const p of Object.values((started ?? {}) as object)) if (p instanceof Promise) p.catch(() => {});
					const { playerId } = await who;
					const out = await fn(a, playerId, started);
					isolate.id ||= crypto.randomUUID().slice(0, 8);
					return out instanceof Response ? out : json({ ...(out as object), wallMs: performance.now() - t0, isolate });
				},
			});
		/** The rules (and the claimed player's record) read with the session, as the http-api plugin does. */
		const rulesAndRecord = ({ kernel, env, url }: RouteContext) => {
			const sync = url.searchParams.get('sync');
			return {
				rules: requestContext(kernel, env, ''),
				record: sync && sync.length <= 64 ? readRecord(kernel, env.DB, sync, Date.now()) : null,
			};
		};
		const contextFor = async (rules: Promise<EngineContext>, playerId: string): Promise<EngineContext> => ({
			...(await rules),
			playerId,
			gmViewer: false,
		});

		add('GET', '/api/_bench/timers', async ({ env, url }) => {
			const n = int(url, 'n', 1, 200_000_000, 20_000_000);
			const p0 = performance.now();
			const d0 = Date.now();
			let x = 0;
			for (let i = 0; i < n; i++) x = (Math.imul(x, 31) + i) | 0;
			const p1 = performance.now();
			const d1 = Date.now();
			await env.DB.prepare('SELECT 1 AS one').first();
			const p2 = performance.now();
			const d2 = Date.now();
			return {
				n,
				x,
				loop: { performance: p1 - p0, date: d1 - d0 },
				afterRead: { performance: p2 - p0, date: d2 - d0 },
				frozen: p1 === p0 && d1 === d0,
			};
		});

		add('GET', '/api/_bench/noop', async () => ({}));

		add('GET', '/api/_bench/d1', async ({ env, url }, playerId) => {
			const n = int(url, 'n', 1, 50, 10);
			const mode = url.searchParams.get('mode') ?? 'seq';
			const statement = () => env.DB.prepare('SELECT version FROM engine_locks WHERE entity = ?').bind(`player:${playerId}`);
			let rows = 0;
			if (mode === 'batch') for (const r of await env.DB.batch(Array.from({ length: n }, statement))) rows += r.results.length;
			else if (mode === 'pack') rows = (await Promise.all(Array.from({ length: n }, () => statement().first()))).filter(Boolean).length;
			else for (let i = 0; i < n; i++) rows += (await statement().first()) ? 1 : 0;
			return { n, mode, rows };
		});

		add('GET', '/api/_bench/assemble', async ({ kernel, env, url }) => {
			const fresh = createKernel(kernel.plugins, { build: pkg.version });
			let overrides = 0;
			if (url.searchParams.get('rules') === '1') {
				// As loadConfig on a new isolate, without its pruning (a write): the stored overrides, every rule worked out.
				const loaded = fresh.services.has('configStore') ? await fresh.services.get('configStore').load(env) : { overrides: {} };
				overrides = Object.keys(loaded.overrides).length;
				resolveConfig(fresh, loaded.overrides);
			}
			return {
				plugins: fresh.plugins.length,
				commands: fresh.commands.size,
				views: fresh.views.length,
				rules: fresh.config.size,
				overrides,
			};
		});

		add(
			'GET',
			'/api/_bench/sync',
			async ({ kernel, env, url }, playerId, { rules, record: claimed }) => {
				// As /api/state (the http-api plugin's playerContext and handler), for the same query.
				const context = await contextFor(rules, playerId);
				const record: Promise<PlayerRecord> | 'read' = claimed && url.searchParams.get('sync') === playerId ? claimed : 'read';
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
				const statics = await staticVersions(kernel, env, { values: context.config, version: context.rulesVersion ?? 0 });
				return { ...state, player: playerId, statics, metaVersion: bakedMetaVersion };
			},
			rulesAndRecord,
		);

		add('GET', '/api/_bench/upgrade', async ({ env }) => {
			// The rules of the version before this one, as a pool last settled before the deploy first reads them.
			const { results } = await env.DB.prepare('SELECT version, file FROM engine_versions ORDER BY started_at DESC LIMIT 2').all<{
				version: string;
				file: string;
			}>();
			const previous = results[1];
			const body = previous ? await env.FILES?.get(previous.file).then((o) => o?.text() ?? null) : null;
			const keys = body ? Object.keys(JSON.parse(body) as object).length : 0;
			return { versions: results.map((r) => r.version), bytes: body?.length ?? 0, keys };
		});

		add('GET', '/api/_bench/target', async ({ env }, playerId) => {
			// The lowest building of the player's not being built (the capital first): what to upgrade in the dry runs.
			const row = await env.DB.prepare(
				`SELECT b.settlement_id AS settlement, b.district_id AS district, b.slot AS slot, b.building AS building, b.level AS level
				 FROM buildings_slots b JOIN settlements_settlements s ON s.id = b.settlement_id
				 WHERE s.owner_id = ? AND NOT EXISTS (SELECT 1 FROM buildings_construction c WHERE c.district_id = b.district_id AND c.slot = b.slot)
				 ORDER BY s.kind = 'capital' DESC, b.level LIMIT 1`,
			)
				.bind(playerId)
				.first<{ settlement: string; district: string; slot: number; building: string; level: number }>();
			return { target: row };
		});

		add('POST', '/api/_bench/raw/:command', async ({ kernel, env, request, params, url }, playerId) => {
			if (params.command !== 'buildings.construct') return notFound(request, url);
			const t = (await readJson(request)) as { settlement?: unknown; district?: unknown; slot?: unknown };
			if (typeof t?.settlement !== 'string' || typeof t.district !== 'string' || !Number.isInteger(t.slot))
				return json({ error: { code: 'bad_payload', message: 'Expected { settlement, district, slot }' } }, { status: 400 });
			const result = await rawConstruct(
				env.DB,
				playerId,
				Date.now(),
				{ settlement: t.settlement, district: t.district, slot: t.slot as number },
				rulesFor(kernel),
			);
			return { result };
		});

		// The body read while the session and the rules are, as /api/command.
		const commandStart = (a: RouteContext) => ({ rules: requestContext(a.kernel, a.env, ''), body: readJson(a.request) });
		add(
			'POST',
			'/api/_bench/real/:command',
			async ({ kernel, env, params, url }, playerId, { rules, body }) => {
				const context = await contextFor(rules, playerId);
				const payload = await body;
				const dry = dryDatabase(env.DB);
				// Files would be written before the commit: none here.
				const files = context.files && { get: context.files.get.bind(context.files), put: async () => {} };
				// `flat=0`: the regular `execute` even where the command has a fast path (to compare the two).
				const ctx = { ...context, ...(files ? { files } : {}), ...(url.searchParams.get('flat') === '0' ? { noFlat: true } : {}) };
				let error: unknown = null;
				let views: unknown = null;
				try {
					const { carried } = await executeCommand(kernel, dry.db, ctx, params.command, payload ?? null);
					const wanted = requestedViews(url);
					if (wanted.length)
						views = await computeViews(
							kernel,
							dry.db,
							ctx,
							wanted,
							viewParams(url),
							requestedInstances(url),
							carried,
							requestedStamps(url),
							'read',
						);
				} catch (err) {
					error = err instanceof Error ? { name: err.name, message: err.message, code: (err as { code?: string }).code } : String(err);
				}
				// The views sent as /api/command sends them (serialising them is part of the work).
				return { ok: error === null, error, replaced: dry.replaced, state: views };
			},
			commandStart,
		);
	},
});
