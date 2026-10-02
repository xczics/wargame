/**
 * GM console backend: live game rules (config overrides), player inspection and
 * privileged commands, with an audit log. All routes require the GM.
 *
 *   GET    /api/gm/config                 every tunable rule: default, override, effective value
 *   PUT    /api/gm/config/:key            { value } -> validate with the owning plugin, store
 *   DELETE /api/gm/config/:key            back to default
 *   GET    /api/gm/commands               privileged commands available to the GM
 *   GET    /api/gm/players                accounts
 *   GET    /api/gm/players/:id/state      a player's state
 *   POST   /api/gm/players/:id/command    { type, payload } run any command (privileged allowed)
 *   POST   /api/gm/players/:id/play       log this browser in as the player (the GM session ends)
 *   GET    /api/gm/forms?player=<id>      GM action forms (placement "gm") for a target player, grouped by plugin
 *   GET    /api/gm/reports                cross-player reports contributed by plugins (`ctx.reports.add`)
 *   POST   /api/gm/reports/:id            { params } -> rows (a `playerId` column gets a `username` next to it)
 *   GET    /api/gm/audit                  recent GM actions
 *
 * Provides the kernel's well-known `configStore` service, which makes overrides apply
 * to every player on their next request, and `gmAudit` for other plugins' GM routes.
 */
import { computeViews, definePlugin, executeCommand, gameErrors, loadConfig, parseConfigValue, runReport } from '../../kernel';
import { json, readJson } from '../../lib/http';
import { requestContext, requestedViews, viewParams } from '../../runtime/context';
import type { AuditEntry, ConfigEntry, PrivilegedCommand, ReportInfo, ReportRows } from '../../shared/api';
import i18nCsv from './data/i18n.csv?raw';

const fail = gameErrors('gm');

export interface GmAuditService {
	/** Log a GM action of another plugin's GM route (after `accounts.requireGM`). */
	record(env: Env, actor: string, action: string, detail: unknown): Promise<void>;
}

declare module '../../kernel' {
	interface ServiceMap {
		gmAudit: GmAuditService;
	}
}

export default definePlugin({
	id: 'gm',
	version: '0.2.0',
	description: 'GM console: live rule tuning, player tools, reports, audit log',
	dependsOn: ['accounts', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const accounts = ctx.services.get('accounts');

		async function loadOverrides(env: Env): Promise<Record<string, unknown>> {
			const { results } = await env.DB.prepare('SELECT key, value FROM gm_config').all<{ key: string; value: string }>();
			const out: Record<string, unknown> = {};
			for (const { key, value } of results) {
				try {
					out[key] = JSON.parse(value);
				} catch {
					console.warn(`gm_config.${key} is not valid JSON; ignored`);
				}
			}
			return out;
		}

		const audit = (env: Env, actor: string, action: string, detail: unknown) =>
			env.DB.prepare('INSERT INTO gm_audit (at, actor, action, detail) VALUES (?, ?, ?, ?)')
				.bind(Date.now(), actor, action, JSON.stringify(detail))
				.run();

		async function pruneOverrides(env: Env, keys: string[]): Promise<void> {
			await env.DB.batch([
				...keys.map((key) => env.DB.prepare('DELETE FROM gm_config WHERE key = ?').bind(key)),
				env.DB.prepare('INSERT INTO gm_audit (at, actor, action, detail) VALUES (?, ?, ?, ?)').bind(
					Date.now(),
					'system',
					'config.prune',
					JSON.stringify({ keys }),
				),
			]);
			console.info('Removed GM overrides of rules that no longer exist:', keys.join(', '));
		}

		ctx.services.provide('configStore', { load: loadOverrides, prune: pruneOverrides });
		ctx.services.provide('gmAudit', { record: async (env, actor, action, detail) => void (await audit(env, actor, action, detail)) });

		ctx.routes.add({
			method: 'GET',
			path: '/api/gm/config',
			async handler({ request, env, kernel }) {
				await accounts.requireGM(request, env);
				const { values, errors } = await loadConfig(kernel, env);
				const overrides = await loadOverrides(env);
				return json(
					[...kernel.config.values()].map(({ key, owner, def }) => ({
						key,
						owner,
						description: def.description,
						default: def.default(),
						overridden: key in overrides,
						override: overrides[key] ?? null,
						value: values[key],
						error: errors[key] ?? null,
					})) satisfies ConfigEntry[],
				);
			},
		});

		ctx.routes.add({
			method: 'PUT',
			path: '/api/gm/config/:key',
			async handler({ request, env, kernel, params }) {
				const gm = await accounts.requireGM(request, env);
				const body = (await readJson(request)) as { value?: unknown } | null;
				if (!body || !('value' in body)) throw fail('bad_payload', 'Body must be { value }');
				// Validate, but store what the GM wrote: partial overrides keep following content defaults.
				const value = parseConfigValue(kernel, params.key, body.value);
				await env.DB.prepare(
					`INSERT INTO gm_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
					 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
				)
					.bind(params.key, JSON.stringify(body.value), Date.now(), gm.id)
					.run();
				await audit(env, gm.username, 'config.set', { key: params.key, value: body.value });
				return json({ key: params.key, value });
			},
		});

		ctx.routes.add({
			method: 'DELETE',
			path: '/api/gm/config/:key',
			async handler({ request, env, params }) {
				const gm = await accounts.requireGM(request, env);
				await env.DB.prepare('DELETE FROM gm_config WHERE key = ?').bind(params.key).run();
				await audit(env, gm.username, 'config.reset', { key: params.key });
				return json({ ok: true });
			},
		});

		ctx.routes.add({
			method: 'GET',
			path: '/api/gm/commands',
			async handler({ request, env, kernel }) {
				await accounts.requireGM(request, env);
				return json(
					[...kernel.commands.values()]
						.filter((c) => c.privileged)
						.map((c) => ({ type: c.type, description: c.description ?? '' })) satisfies PrivilegedCommand[],
				);
			},
		});

		ctx.routes.add({
			method: 'GET',
			path: '/api/gm/players',
			async handler({ request, env, url }) {
				await accounts.requireGM(request, env);
				const limit = Number(url.searchParams.get('limit') ?? 100);
				const offset = Number(url.searchParams.get('offset') ?? 0);
				return json(await accounts.list(env, { limit, offset }));
			},
		});

		const requireTarget = async (env: Env, id: string) => {
			if (!(await accounts.get(env, id))) throw fail('not_found', 'No such player', 404);
		};

		ctx.routes.add({
			method: 'GET',
			path: '/api/gm/players/:id/state',
			async handler({ kernel, request, env, params, url }) {
				await accounts.requireGM(request, env);
				await requireTarget(env, params.id);
				return json(await computeViews(kernel, env.DB, await requestContext(kernel, env, params.id), requestedViews(url), viewParams(url)));
			},
		});

		ctx.routes.add({
			method: 'POST',
			path: '/api/gm/players/:id/command',
			async handler({ kernel, request, env, params }) {
				const gm = await accounts.requireGM(request, env);
				const body = (await readJson(request)) as { type?: unknown; payload?: unknown } | null;
				if (typeof body?.type !== 'string') throw fail('bad_command', 'Body must be { type: string, payload?: unknown }');
				await requireTarget(env, params.id);
				// The command runs AS the target player, with privileged commands unlocked.
				const context = await requestContext(kernel, env, params.id, true);
				await executeCommand(kernel, env.DB, context, body.type, body.payload ?? null);
				await audit(env, gm.username, 'player.command', { player: params.id, type: body.type, payload: body.payload });
				return json(await computeViews(kernel, env.DB, context));
			},
		});

		// "Play as": this browser becomes the player's (no GM rights in that session); back to the GM
		// by logging out and in again. The GM session ends, so the switch cannot be undone from here.
		ctx.routes.add({
			method: 'POST',
			path: '/api/gm/players/:id/play',
			async handler({ request, env, params }) {
				const gm = await accounts.requireGM(request, env);
				const target = await accounts.get(env, params.id);
				if (!target) throw fail('not_found', 'No such player', 404);
				if (target.gm) throw fail('bad_request', 'That is the GM account');
				await audit(env, gm.username, 'player.play', { player: params.id, username: target.username });
				const cookie = await accounts.switchSession(request, env, target.id);
				return json({ user: { ...target, gm: false } }, { headers: { 'set-cookie': cookie } });
			},
		});

		ctx.routes.add({
			method: 'GET',
			path: '/api/gm/forms',
			async handler({ kernel, request, env, url }) {
				await accounts.requireGM(request, env);
				const player = url.searchParams.get('player');
				if (!player) throw fail('bad_params', 'player is required');
				await requireTarget(env, player);
				const params = { ...viewParams(url), placement: 'gm' };
				delete (params as Record<string, string>).player;
				const context = await requestContext(kernel, env, player, true);
				return json((await computeViews(kernel, env.DB, context, ['ui.forms'], params)).views['ui.forms']);
			},
		});

		ctx.routes.add({
			method: 'GET',
			path: '/api/gm/reports',
			async handler({ kernel, request, env }) {
				await accounts.requireGM(request, env);
				return json(
					[...kernel.reports.values()].map((r) => ({
						id: r.id,
						owner: r.owner,
						// An i18n key of the plugin owning the report.
						description: `${r.owner}.${r.description}`,
						example: r.example ?? {},
					})) satisfies ReportInfo[],
				);
			},
		});

		ctx.routes.add({
			method: 'POST',
			path: '/api/gm/reports/:id',
			async handler({ kernel, request, env, params }) {
				const gm = await accounts.requireGM(request, env);
				const body = (await readJson(request)) as { params?: unknown } | null;
				const rows = await runReport(kernel, env.DB, await requestContext(kernel, env, gm.id, true), params.id, body?.params ?? {});
				const ids = [...new Set(rows.map((r) => r.playerId).filter((id): id is string => typeof id === 'string'))];
				const names = await accounts.usernames(env.DB, ids);
				return json(
					rows.map((r) =>
						typeof r.playerId === 'string' ? { playerId: r.playerId, username: names[r.playerId] ?? null, ...r } : r,
					) satisfies ReportRows,
				);
			},
		});

		ctx.routes.add({
			method: 'GET',
			path: '/api/gm/audit',
			async handler({ request, env }) {
				await accounts.requireGM(request, env);
				const { results } = await env.DB.prepare('SELECT at, actor, action, detail FROM gm_audit ORDER BY id DESC LIMIT 200').all<{
					at: number;
					actor: string;
					action: string;
					detail: string;
				}>();
				return json(results.map((r) => ({ ...r, detail: JSON.parse(r.detail) })) satisfies AuditEntry[]);
			},
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		// Only the GM's client has these widgets: for anyone else they are skipped.
		ui.page({ id: 'gm', label: 'GM', order: 100, tab: false, widget: 'gm.panel' });
		ui.slot({ slot: 'user-actions', widget: 'gm.badge', order: 10 });
	},
});
