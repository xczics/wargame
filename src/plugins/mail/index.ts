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
 * The list (view `mail.inbox`) carries what each message is, not what it says; a message whole is the view
 * `mail.message` (param `mail`), fetched when opened and kept by the client (it never changes).
 *
 * A sender may `present` its kind: the message then carries a generic report (widget `ui.report`), built when read —
 * so old messages follow the current presentation.
 *
 * The GM can write to everyone: `POST /api/gm/mail/broadcast` { title, body, attachments? } is one row (`mail_broadcasts`)
 * that every account made before it reads in its mailbox; its attachments are rewards (`rewards` register: resources,
 * items, coupons... whatever their owners added), claimed once per player (`mail.claim`). What a player did with such a
 * mail (read, deleted, claimed) is a row of theirs only once they do. The rule `mail.announcement` is a banner on every
 * page (generic `ui.banner`).
 */
import { csvRules, definePlugin, type EngineApi, fields, gameErrors, numberInRange, type ReadApi, seededRandom, shape } from '../../kernel';
import { json, readJson } from '../../lib/http';
import type { MailBroadcastRequest, MailHeader, MailInbox, MailMessage, Reward } from '../../shared/api';
import type { BannerData, ReportData, UiText } from '../../shared/ui';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import { literal, uiTexts } from '../../shared/i18n';

const fail = gameErrors('mail');
const text = uiTexts('mail');

const RULES = csvRules(rulesCsv);
const PAGE = 30;
const MAX_IDS = 100;
const MAX_ATTACHMENTS = 20;
const BROADCAST = 'mail.broadcast';
/** The GM's mail to everyone has ids of its own ("b-<uuid>"), so a command knows the table by the id. */
const isBroadcast = (id: string) => id.startsWith('b-');

export interface OutgoingMail {
	/** Namespaced by the sending plugin, e.g. "war-reports.march". */
	kind: string;
	/** The sender's text, e.g. `text('Victory at ({x}, {y})', { x, y })`. */
	title: UiText;
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

interface HeaderRow {
	id: string;
	at: number;
	kind: string;
	title: string;
	vars: string;
	read: number;
	gift: 'unclaimed' | 'claimed' | null;
}

interface BroadcastRow {
	id: string;
	at: number;
	title: string;
	body: string;
	attachments: string;
	read: number | null;
	deleted: number | null;
	claimed_at: number | null;
}

/** `ids` of messages, or `all: true` (ids null). */
const parseSelection = shape(
	{ ids: fields.optional(fields.list(fields.id(), { min: 1, max: MAX_IDS })), all: fields.orElse(fields.bool(), false) },
	(p): { ids: string[] | null } => {
		if (p.all) return { ids: null };
		if (!p.ids) throw fail('bad_payload', text('ids must be 1-{0} message ids, or all: true', { 0: MAX_IDS }));
		return { ids: p.ids };
	},
);

const parseBroadcast = shape({
	title: fields.text({ max: 100 }),
	body: fields.text({ max: 2000 }),
	attachments: fields.orElse(fields.list(fields.raw(), { min: 0, max: MAX_ATTACHMENTS }), []),
});

const marks = (n: number) => Array.from({ length: n }, () => '?').join(',');

export default definePlugin({
	id: 'mail',
	version: '0.2.0',
	description: 'Mailbox: messages from other plugins (battle reports, notices)',
	dependsOn: ['accounts', 'gm', 'rewards', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const accounts = ctx.services.get('accounts');
		const rewards = ctx.services.get('rewards');
		const keep = ctx.config.define('keep', {
			description: 'Messages kept per player; older ones are deleted as new ones arrive.',
			default: () => RULES.keep as number,
			parse: numberInRange(1, 10_000),
		});

		const presenters = new Map<string, (api: ReadApi, message: MailMessage) => Promise<ReportData>>();
		ctx.services.provide('mail', {
			present: (kind, presenter) => void presenters.set(kind, presenter),
			send(api, playerId, mail) {
				api.write(
					api.db
						.prepare('INSERT INTO mail_messages (id, player_id, at, kind, title, vars, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
						.bind(
							crypto.randomUUID(),
							playerId,
							mail.at ?? api.now,
							mail.kind,
							mail.title.text,
							JSON.stringify(mail.title.vars ?? {}),
							JSON.stringify(mail.data ?? null),
						),
					api.db
						.prepare(
							`DELETE FROM mail_messages WHERE player_id = ? AND id IN
							 (SELECT id FROM mail_messages WHERE player_id = ? ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?)`,
						)
						.bind(playerId, playerId, Math.floor(keep.get(api))),
				);
			},
		});

		/** From when the GM's mail to everyone reaches this player (their account's making); none: no such mail at all. */
		const sinceOf = (api: ReadApi) =>
			api.memo(`mail:since:${api.playerId}`, async () => (await accounts.joinedAt(api.db, api.playerId)) ?? Number.MAX_SAFE_INTEGER);

		// The badge's number on every page: one small statement (the inbox itself only on the mail page).
		const unreadOf = (api: ReadApi) =>
			api.memo(`mail:unread:${api.playerId}`, async () => {
				const row = await api.db
					.prepare(
						`SELECT (SELECT COUNT(*) FROM mail_messages WHERE player_id = ? AND read = 0)
						      + (SELECT COUNT(*) FROM mail_broadcasts b WHERE b.at >= ? AND NOT EXISTS
						          (SELECT 1 FROM mail_broadcast_marks m WHERE m.player_id = ? AND m.broadcast_id = b.id AND (m.read = 1 OR m.deleted = 1))) AS n`,
					)
					.bind(api.playerId, await sinceOf(api), api.playerId)
					.first<{ n: number }>();
				return row?.n ?? 0;
			});

		/** The GM's mail to everyone, as this player sees it (null: not theirs to see, or deleted). */
		const broadcastOf = (api: ReadApi, id: string) =>
			api.memo(`mail:broadcast:${api.playerId}:${id}`, async () => {
				const row = await api.db
					.prepare(
						`SELECT b.id, b.at, b.title, b.body, b.attachments, m.read, m.deleted, m.claimed_at FROM mail_broadcasts b
						 LEFT JOIN mail_broadcast_marks m ON m.player_id = ? AND m.broadcast_id = b.id WHERE b.id = ? AND b.at >= ?`,
					)
					.bind(api.playerId, id, await sinceOf(api))
					.first<BroadcastRow>();
				return row && !row.deleted ? { ...row, attachments: JSON.parse(row.attachments) as Reward[] } : null;
			});

		// What the GM wrote to everyone is shown as written.
		const titleOf = (r: { kind: string; title: string; vars: string }): UiText =>
			r.kind === BROADCAST ? literal(r.title) : { text: r.title, vars: JSON.parse(r.vars) as UiText['vars'] };

		ctx.views.add({ id: 'mail.unread', compute: async (api) => ({ unread: await unreadOf(api) }) });
		ctx.views.add({
			id: 'mail.inbox',
			async compute(api, params): Promise<MailInbox> {
				// Page cursor: the last message shown (`mailBefore` = its time, `mailBeforeId` = its id; newest first, by id
				// within the same time). One statement: the player's own messages and the GM's to everyone, each a range of its index.
				const before = Number(params.mailBefore);
				const at = Number.isFinite(before) && params.mailBefore ? before : Number.MAX_SAFE_INTEGER;
				const id = params.mailBefore ? (params.mailBeforeId ?? '') : '';
				const [{ results }, unread] = await Promise.all([
					api.db
						.prepare(
							`SELECT * FROM (SELECT id, at, kind, title, vars, read, NULL AS gift FROM mail_messages
							   WHERE player_id = ? AND (at, id) < (?, ?) ORDER BY at DESC, id DESC LIMIT ?)
							 UNION ALL
							 SELECT * FROM (SELECT b.id, b.at, '${BROADCAST}' AS kind, b.title, '{}' AS vars, COALESCE(m.read, 0) AS read,
							     CASE WHEN b.attachments = '[]' THEN NULL WHEN m.claimed_at IS NULL THEN 'unclaimed' ELSE 'claimed' END AS gift
							   FROM mail_broadcasts b LEFT JOIN mail_broadcast_marks m ON m.player_id = ? AND m.broadcast_id = b.id
							   WHERE b.at >= ? AND (b.at, b.id) < (?, ?) AND COALESCE(m.deleted, 0) = 0 ORDER BY b.at DESC, b.id DESC LIMIT ?)
							 ORDER BY at DESC, id DESC LIMIT ?`,
						)
						.bind(api.playerId, at, id, PAGE + 1, api.playerId, await sinceOf(api), at, id, PAGE + 1, PAGE + 1)
						.all<HeaderRow>(),
					unreadOf(api),
				]);
				return {
					messages: results.slice(0, PAGE).map((r): MailHeader => ({
						id: r.id,
						at: r.at,
						kind: r.kind,
						title: titleOf(r),
						read: !!r.read,
						...(r.gift ? { gift: r.gift } : {}),
					})),
					unread,
					more: results.length > PAGE,
				};
			},
		});

		ctx.views.add({
			id: 'mail.message',
			async compute(api, params): Promise<MailMessage | null> {
				const id = params.mail;
				if (!id) return null;
				let message: MailMessage;
				if (isBroadcast(id)) {
					const b = await broadcastOf(api, id);
					if (!b) return null;
					message = {
						id: b.id,
						at: b.at,
						kind: BROADCAST,
						title: literal(b.title),
						read: !!b.read,
						data: { body: b.body },
						...(b.attachments.length
							? { attachments: b.attachments.map((r) => rewards.describe(r)), gift: b.claimed_at === null ? 'unclaimed' : 'claimed' }
							: {}),
					};
				} else {
					const r = await api.db
						.prepare('SELECT id, at, kind, title, vars, data, read FROM mail_messages WHERE id = ? AND player_id = ?')
						.bind(id, api.playerId)
						.first<HeaderRow & { data: string }>();
					if (!r) return null;
					message = { id: r.id, at: r.at, kind: r.kind, title: titleOf(r), read: !!r.read, data: JSON.parse(r.data) };
				}
				const present = presenters.get(message.kind);
				// A message its presenter cannot read (e.g. from an older version) shows without a body rather than failing.
				if (present) message.report = await present(api, message).catch(() => undefined);
				return message;
			},
		});

		/* ----- GM: to everyone ------------------------------------------------------------ */

		const gmAudit = ctx.services.get('gmAudit');
		ctx.routes.add({
			method: 'POST',
			path: '/api/gm/mail/broadcast',
			async handler({ request, env }) {
				const gm = await accounts.requireGM(request, env);
				const p = parseBroadcast((await readJson(request)) ?? {});
				// Checked by their kinds now, so a claim later only gives.
				const mail: Required<MailBroadcastRequest> = {
					title: p.title,
					body: p.body,
					attachments: p.attachments.map((r) => {
						const reward = rewards.check(r);
						// Claimed with one click: nowhere to choose a settlement (puzzles ask for one).
						if (rewards.choosesSettlement(reward))
							throw fail('bad_payload', 'An attachment cannot be aimed at a settlement the player chooses');
						return reward;
					}),
				};
				const id = `b-${crypto.randomUUID()}`;
				await env.DB.prepare('INSERT INTO mail_broadcasts (id, at, title, body, attachments) VALUES (?, ?, ?, ?, ?)')
					.bind(id, Date.now(), mail.title, mail.body, JSON.stringify(mail.attachments))
					.run();
				await gmAudit.record(env, gm.username, 'mail.broadcast', { id, title: mail.title, attachments: mail.attachments });
				return json({ id });
			},
		});
		presenters.set(BROADCAST, async (_api, m) => ({
			lines: String((m.data as { body?: unknown } | null)?.body ?? '')
				.split('\n')
				// Written by the GM: shown as it is.
				.map((line) => ({ text: literal(line) })),
		}));

		const announcement = ctx.config.define('announcement', {
			description: 'Banner shown to every player on every page (empty: none). At most 200 characters.',
			default: () => '',
			// GM input is untrusted: bounded plain text (the client never renders it as HTML).
			parse(raw) {
				if (typeof raw !== 'string' || raw.length > 200) throw fail('bad_config', 'announcement: a string of at most 200 characters');
				return raw.trim();
			},
		});
		ctx.views.add({
			id: 'mail.announcement',
			async compute(api): Promise<BannerData | null> {
				const t = announcement.get(api);
				return t ? { text: text('{0}', { 0: t }), icon: '📢', key: t } : null;
			},
		});

		/* ----- the player's commands -------------------------------------------------------- */

		/** The ids split by table; null: all of them. */
		const split = (ids: string[] | null) => ({
			own: ids?.filter((id) => !isBroadcast(id)) ?? null,
			theirs: ids?.filter(isBroadcast) ?? null,
		});
		const own = (ids: string[] | null) => (ids ? ` AND id IN (${marks(ids.length)})` : '');
		/** GM mails whose attachments are claimed, or that have none (`b`: the mail; one parameter: the player). */
		const claimedOrPlain = `(b.attachments = '[]' OR EXISTS
			(SELECT 1 FROM mail_broadcast_marks c WHERE c.player_id = ? AND c.broadcast_id = b.id AND c.claimed_at IS NOT NULL))`;
		/**
		 * Mark the GM's mails (the player's, from when they joined) read, or deleted too; a row each, made on the first mark.
		 * Deleting them all leaves out those with attachments still to claim.
		 */
		const mark = async (api: EngineApi, ids: string[] | null, deleted: boolean) => {
			const keepUnclaimed = deleted && !ids;
			api.write(
				api.db
					.prepare(
						`INSERT INTO mail_broadcast_marks (player_id, broadcast_id, read, deleted) SELECT ?, b.id, 1, ? FROM mail_broadcasts b
						 WHERE b.at >= ?${ids ? ` AND b.id IN (${marks(ids.length)})` : ''}${keepUnclaimed ? ` AND ${claimedOrPlain}` : ''}
						 ON CONFLICT (player_id, broadcast_id) DO UPDATE SET read = 1${deleted ? ', deleted = 1' : ''}`,
					)
					.bind(api.playerId, deleted ? 1 : 0, await sinceOf(api), ...(ids ?? []), ...(keepUnclaimed ? [api.playerId] : [])),
			);
		};

		ctx.commands.add<{ ids: string[] | null }>({
			type: 'mail.read',
			description: 'Mark messages as read. Payload: { "ids": ["<id>"] } or { "all": true }',
			parse: parseSelection,
			async execute(api, { ids }) {
				const { own: mine, theirs } = split(ids);
				if (!mine || mine.length)
					api.write(
						api.db.prepare(`UPDATE mail_messages SET read = 1 WHERE player_id = ?${own(mine)}`).bind(api.playerId, ...(mine ?? [])),
					);
				if (!theirs || theirs.length) await mark(api, theirs, false);
			},
		});

		ctx.commands.add<{ ids: string[] | null }>({
			type: 'mail.delete',
			description:
				'Delete messages (a GM mail only once its attachments are claimed; "all" leaves those out). Payload: { "ids": ["<id>"] } or { "all": true }',
			parse: parseSelection,
			async execute(api, { ids }) {
				const { own: mine, theirs } = split(ids);
				if (theirs?.length) {
					const { results } = await api.db
						.prepare(`SELECT b.id FROM mail_broadcasts b WHERE b.id IN (${marks(theirs.length)}) AND NOT ${claimedOrPlain} LIMIT 1`)
						.bind(...theirs, api.playerId)
						.all<{ id: string }>();
					if (results.length) throw fail('unclaimed', 'Claim the attachments first');
				}
				if (!mine || mine.length)
					api.write(api.db.prepare(`DELETE FROM mail_messages WHERE player_id = ?${own(mine)}`).bind(api.playerId, ...(mine ?? [])));
				if (!theirs || theirs.length) await mark(api, theirs, true);
			},
		});

		ctx.commands.add<{ id: string }>({
			type: 'mail.claim',
			description: 'Claim the attachments of a GM mail (once). Payload: { "id": "<message id>" }',
			parse: shape({ id: fields.id() }),
			async execute(api, { id }) {
				const b = isBroadcast(id) ? await broadcastOf(api, id) : null;
				if (!b) throw fail('not_found', 'No such message', 404);
				if (!b.attachments.length) throw fail('no_attachments', 'Nothing to claim');
				// The player's lock makes this once: a claim at the same moment retries, and finds it claimed.
				if (b.claimed_at !== null) throw fail('claimed', 'Already claimed');
				const random = seededRandom(`mail:claim:${api.playerId}:${id}`);
				for (const r of b.attachments) await rewards.give(api, api.playerId, r, random);
				api.write(
					api.db
						.prepare(
							`INSERT INTO mail_broadcast_marks (player_id, broadcast_id, read, claimed_at) VALUES (?, ?, 1, ?)
							 ON CONFLICT (player_id, broadcast_id) DO UPDATE SET read = 1, claimed_at = excluded.claimed_at`,
						)
						.bind(api.playerId, id, api.now),
				);
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
		ui.mail(BROADCAST, 'ui.report');
	},
});
