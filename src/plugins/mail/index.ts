/**
 * Mailbox: messages to players — battle reports, notices of routed troops, anything another
 * plugin wants a player to read later. The mail plugin knows nothing about what is in them:
 * a message has a namespaced `kind` (the client picks a renderer by it), a title with
 * {placeholders} and a JSON body.
 *
 * `send` queues the message in the current command, so it is committed atomically with
 * whatever it reports (and dropped with it on failure or in a dry-run view). Timeline
 * handlers can send too: the event is committed once, so the message arrives once.
 * Only the newest `mail.keep` messages per player are kept.
 *
 * A sender may `present` its kind: the inbox then carries each such message as a generic report
 * (widget `ui.report`), built when read — so old messages follow the current presentation.
 *
 * The GM can write to everyone: `POST /api/gm/mail/broadcast` { title, body } puts a message in every
 * player's mailbox, and the rule `mail.announcement` is a banner on every page (generic `ui.banner`).
 */
import { csvRules, definePlugin, type EngineApi, GameError, numberInRange, type ReadApi } from '../../kernel';
import { json, readJson } from '../../lib/http';
import type { MailInbox, MailMessage } from '../../shared/api';
import type { BannerData, ReportData } from '../../shared/ui';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { mapUiTexts } from '../../shared/i18n';

const RULES = csvRules(rulesCsv);
const PAGE = 30;
const MAX_IDS = 100;

export interface OutgoingMail {
	/** Namespaced by the sending plugin, e.g. "war-reports.march". */
	kind: string;
	/** Text the client translates, with {placeholders} filled from `vars`. */
	title: string;
	vars?: Record<string, string | number>;
	data?: unknown;
	/** When it happened (e.g. `event.dueAt` in a timeline handler); default `api.now`. */
	at?: number;
}

export interface MailService {
	/** Deliver a message to a player in the current commit. */
	send(api: EngineApi, playerId: string, mail: OutgoingMail): void;
	/** Show messages of `kind` as a generic report (declare `ui.mail(kind, 'ui.report')`). Must only read. */
	present(kind: string, presenter: (api: ReadApi, message: MailMessage) => Promise<ReportData>): void;
}

declare module '../../kernel' {
	interface ServiceMap {
		mail: MailService;
	}
}

interface Row {
	id: string;
	at: number;
	kind: string;
	title: string;
	vars: string;
	data: string;
	read: number;
}

/** `{ ids: [...] }` or `{ all: true }`. */
function parseSelection(raw: unknown): { ids: string[] | null } {
	const p = (raw ?? {}) as { ids?: unknown; all?: unknown };
	if (p.all === true) return { ids: null };
	if (!Array.isArray(p.ids) || !p.ids.length || p.ids.length > MAX_IDS || !p.ids.every((id) => typeof id === 'string'))
		throw new GameError('bad_payload', `ids must be 1-${MAX_IDS} message ids, or all: true`, 400, 'mail');
	return { ids: p.ids };
}

export default definePlugin({
	id: 'mail',
	version: '0.1.0',
	description: 'Mailbox: messages from other plugins (battle reports, notices)',
	dependsOn: ['accounts', 'gm', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const keep = ctx.config.define('keep', {
			description: 'Messages kept per player; older ones are deleted as new ones arrive.',
			default: () => RULES.keep as number,
			parse: numberInRange(1, 10_000),
		});

		const presenters = new Map<string, (api: ReadApi, message: MailMessage) => Promise<ReportData>>();
		ctx.services.provide('mail', {
			present(kind, presenter) {
				// A report's texts are i18n keys of the plugin presenting it.
				const own = ctx.services.get('i18n').scope();
				presenters.set(kind, async (api, m) => mapUiTexts(await presenter(api, m), own));
			},
			send(api, playerId, mail) {
				api.write(
					api.db
						.prepare('INSERT INTO mail_messages (id, player_id, at, kind, title, vars, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
						.bind(
							crypto.randomUUID(),
							playerId,
							mail.at ?? api.now,
							mail.kind,
							mail.title,
							JSON.stringify(mail.vars ?? {}),
							JSON.stringify(mail.data ?? null),
						),
					api.db
						.prepare(
							`DELETE FROM mail_messages WHERE player_id = ? AND id IN
							 (SELECT id FROM mail_messages WHERE player_id = ? ORDER BY at DESC, id LIMIT -1 OFFSET ?)`,
						)
						.bind(playerId, playerId, Math.floor(keep.get(api))),
				);
			},
		});

		ctx.views.add({
			id: 'mail.inbox',
			async compute(api, params): Promise<MailInbox> {
				// Page cursor: the last message shown (`mailBefore` = its time, `mailBeforeId` = its id; messages sharing a time go by id).
				const before = Number(params.mailBefore);
				const at = Number.isFinite(before) && params.mailBefore ? before : Number.MAX_SAFE_INTEGER;
				const { results } = await api.db
					.prepare('SELECT * FROM mail_messages WHERE player_id = ? AND (at < ? OR (at = ? AND id > ?)) ORDER BY at DESC, id LIMIT ?')
					.bind(api.playerId, at, at, params.mailBeforeId ?? '', PAGE + 1)
					.all<Row>();
				const unread = await api.db
					.prepare('SELECT COUNT(*) AS n FROM mail_messages WHERE player_id = ? AND read = 0')
					.bind(api.playerId)
					.first<{ n: number }>();
				// A title and its texts are i18n keys of the plugin that sent it (the one in its kind); what the GM
				// wrote to everyone is shown as written.
				const i18n = ctx.services.get('i18n');
				const ownBy = (kind: string, text: string) =>
					kind === 'mail.broadcast' || i18n.isKey(text) ? text : `${kind.slice(0, kind.indexOf('.'))}.${text}`;
				const messages = results.slice(0, PAGE).map((r): MailMessage => ({
					id: r.id,
					at: r.at,
					kind: r.kind,
					title: ownBy(r.kind, r.title),
					vars: Object.fromEntries(
						Object.entries(JSON.parse(r.vars) as Record<string, unknown>).map(([k, v]) => [
							k,
							typeof v === 'string' ? ownBy(r.kind, v) : (v as number),
						]),
					),
					data: JSON.parse(r.data),
					read: !!r.read,
				}));
				for (const m of messages) {
					const present = presenters.get(m.kind);
					// A message its presenter cannot read (e.g. from an older version) shows without a body
					// rather than failing the whole state.
					if (present) m.report = await present(api, m).catch(() => undefined);
				}
				return {
					messages,
					unread: unread?.n ?? 0,
					more: results.length > PAGE,
				};
			},
		});

		/* ----- GM: to everyone ------------------------------------------------------------ */

		const accounts = ctx.services.get('accounts');
		const gmAudit = ctx.services.get('gmAudit');
		const text = (v: unknown, name: string, max: number) => {
			if (typeof v !== 'string' || !v.trim() || v.length > max)
				throw new GameError('bad_payload', `${name}: 1-${max} characters`, 400, 'mail');
			return v.trim();
		};
		// Every player gets a copy (a plain mail, read and deleted like any other); the body shows as a report.
		ctx.routes.add({
			method: 'POST',
			path: '/api/gm/mail/broadcast',
			async handler({ request, env }) {
				const gm = await accounts.requireGM(request, env);
				const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
				const title = text(body.title, 'title', 100);
				const message = text(body.body, 'body', 2000);
				const at = Date.now();
				let sent = 0;
				for (let offset = 0; ; offset += 500) {
					const users = await accounts.list(env, { limit: 500, offset });
					for (let i = 0; i < users.length; i += 50)
						await env.DB.batch(
							users
								.slice(i, i + 50)
								.map((u) =>
									env.DB.prepare(
										'INSERT INTO mail_messages (id, player_id, at, kind, title, vars, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
									).bind(crypto.randomUUID(), u.id, at, 'mail.broadcast', title, '{}', JSON.stringify({ body: message })),
								),
						);
					sent += users.length;
					if (users.length < 500) break;
				}
				await gmAudit.record(env, gm.username, 'mail.broadcast', { title, sent });
				return json({ sent });
			},
		});
		presenters.set('mail.broadcast', async (_api, m) => ({
			lines: String((m.data as { body?: unknown } | null)?.body ?? '')
				.split('\n')
				.map((line) => ({ text: { text: '{0}', vars: { 0: line } } })),
		}));

		const announcement = ctx.config.define('announcement', {
			description: 'Banner shown to every player on every page (empty: none). At most 200 characters.',
			default: () => '',
			// GM input is untrusted: bounded plain text (the client never renders it as HTML).
			parse(raw) {
				if (typeof raw !== 'string' || raw.length > 200)
					throw new GameError('bad_config', 'announcement: a string of at most 200 characters', 400, 'mail');
				return raw.trim();
			},
		});
		ctx.views.add({
			id: 'mail.announcement',
			async compute(api): Promise<BannerData | null> {
				const t = announcement.get(api);
				return t ? { text: { text: '{0}', vars: { 0: t } }, icon: '📢', key: t } : null;
			},
		});

		const where = (ids: string[] | null) => (ids ? ` AND id IN (${ids.map(() => '?').join(',')})` : '');

		ctx.commands.add<{ ids: string[] | null }>({
			type: 'mail.read',
			description: 'Mark messages as read. Payload: { "ids": ["<id>"] } or { "all": true }',
			parse: parseSelection,
			async execute(api, { ids }) {
				api.write(api.db.prepare(`UPDATE mail_messages SET read = 1 WHERE player_id = ?${where(ids)}`).bind(api.playerId, ...(ids ?? [])));
			},
		});

		ctx.commands.add<{ ids: string[] | null }>({
			type: 'mail.delete',
			description: 'Delete messages. Payload: { "ids": ["<id>"] } or { "all": true }',
			parse: parseSelection,
			async execute(api, { ids }) {
				api.write(api.db.prepare(`DELETE FROM mail_messages WHERE player_id = ?${where(ids)}`).bind(api.playerId, ...(ids ?? [])));
			},
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		// Opened from the envelope in the top band, so no tab of its own.
		ui.page({ id: 'mail', label: 'Mail', order: 9.5, tab: false });
		ui.block({ page: 'mail', column: 'left', widget: 'mail.list' });
		ui.block({ page: 'mail', column: 'right', widget: 'mail.view' });
		ui.band({ band: 'top', widget: 'mail.badge', order: -1 });
		ui.band({ band: 'top', widget: 'ui.banner', order: 100, props: { view: 'mail.announcement' } });
		ui.mail('mail.broadcast', 'ui.report');
	},
});
