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
 */
import { csvRules, definePlugin, type EngineApi, GameError, numberInRange } from '../../kernel';
import type { MailInbox, MailMessage } from '../../shared/api';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

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
		throw new GameError('bad_payload', `ids must be 1-${MAX_IDS} message ids, or all: true`);
	return { ids: p.ids };
}

export default definePlugin({
	id: 'mail',
	version: '0.1.0',
	description: 'Mailbox: messages from other plugins (battle reports, notices)',
	dependsOn: ['ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv);
		const keep = ctx.config.define('keep', {
			description: 'Messages kept per player; older ones are deleted as new ones arrive.',
			default: () => RULES.keep as number,
			parse: numberInRange(1, 10_000),
		});

		ctx.services.provide('mail', {
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
				return {
					messages: results.slice(0, PAGE).map((r): MailMessage => ({
						id: r.id,
						at: r.at,
						kind: r.kind,
						title: r.title,
						vars: JSON.parse(r.vars),
						data: JSON.parse(r.data),
						read: !!r.read,
					})),
					unread: unread?.n ?? 0,
					more: results.length > PAGE,
				};
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
	},
});
