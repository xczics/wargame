/**
 * War reports: turns what happens to a player's troops into mail.
 *
 *   war-reports.march     an army of theirs reached its target (battle, transfer, founding...)
 *   war-reports.defense   one of their settlements was attacked
 *   war-reports.shortage  upkeep ran out and troops left or dropped a tier
 *
 * The systems involved (armies, pvp, troops) only announce their events; this plugin decides
 * what the player is told. Each message is committed with the event itself. The mailbox shows
 * them as generic reports (`ui.report`, lanes as `ui.lanes`), assembled in the browser (web/plugins/war-reports).
 *
 * A battle is stored once (`war_reports_battles`), however many reports tell of it (user 2026-10-21: "把战斗数据只存一份，
 * 两封信都只记一个战斗编号"): the attacker's and the defender's mail keep what is theirs and the battle's id. The row
 * counts the mails pointing at it and goes with the last of them (`mail.onRemoved`). Mails from before keep the whole
 * report in their own data (`report`) and are read from there.
 */
import { definePlugin, type EngineApi, PluginError, type ReadApi } from '../../kernel';
import type { BattleReport, DefenseMail, MailMessage, MarchMail, ShortageMail, WarReportAttached } from '../../shared/api';
import type { UiText } from '../../shared/ui';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, literal, uiTexts } from '../../shared/i18n';

const text = uiTexts('war-reports');

export default definePlugin({
	id: 'war-reports',
	version: '0.1.0',
	description: 'Battle reports and troop notices, sent to the mailbox',
	dependsOn: ['mail', 'armies', 'pvp', 'troops', 'battle', 'settlements', 'resources', 'accounts', 'ui', 'i18n'],
	tables: ['war_reports_battles'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const mail = ctx.services.get('mail');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const accounts = ctx.services.get('accounts');

		/* ----- the battles, once each ---------------------------------------------------- */

		/** A battle written by this commit: how many of its mails point at it so far. */
		interface Pending {
			report: BattleReport;
			at: number;
			refs: number;
			written: boolean;
		}
		/**
		 * Battles of this commit, by id, keyed by the command's database handle (one per run; a retry gets a new one, and
		 * timeline handlers' `{ ...api }` share it). Both reports of a PvP battle are the same object (pvp.raid's, passed
		 * on to `armies.onArrive`): `idOf` finds the battle by it.
		 */
		const pendingIn = new WeakMap<object, Map<string, Pending>>();
		const idOf = new WeakMap<BattleReport, string>();
		/** The battle's id for one more mail: written once, before the commit (after the mailbox let go of any it pushed out). */
		const share = (api: EngineApi, report: BattleReport, at: number): string => {
			let inCommit = pendingIn.get(api.db);
			if (!inCommit) pendingIn.set(api.db, (inCommit = new Map()));
			const known = idOf.get(report);
			const entry = known ? inCommit.get(known) : undefined;
			if (known && entry && !entry.written) return (entry.refs++, known);
			const id = crypto.randomUUID();
			idOf.set(report, id);
			const battle: Pending = { report, at, refs: 1, written: false };
			inCommit.set(id, battle);
			api.beforeCommit(
				`war-reports:battle:${id}`,
				() => {
					battle.written = true;
					// Every mail of it already gone (a mailbox keeping fewer than this commit sent): nothing to keep.
					if (battle.refs > 0)
						api.write(
							api.db
								.prepare('INSERT INTO war_reports_battles (id, at, data, refs) VALUES (?, ?, ?, ?)')
								.bind(id, battle.at, JSON.stringify(battle.report), battle.refs),
						);
				},
				{ last: true, writes: ['war_reports_battles'] },
			);
			return id;
		};
		/** Mails gone: their battles count fewer, and go at none (two statements, however many). */
		const release = (api: EngineApi, messages: { data: unknown }[]) => {
			const counts: Record<string, number> = {};
			const inCommit = pendingIn.get(api.db);
			for (const m of messages) {
				const id = (m.data as { battle?: unknown } | null)?.battle;
				if (typeof id !== 'string') continue; // a mail from before: the report was its own
				const entry = inCommit?.get(id);
				if (entry && !entry.written) entry.refs--;
				else counts[id] = (counts[id] ?? 0) + 1;
			}
			if (!Object.keys(counts).length) return;
			const ids = JSON.stringify(counts);
			api.write(
				api.db
					.prepare(
						`UPDATE war_reports_battles SET refs = MAX(0, refs - (SELECT j.value FROM json_each(?) j WHERE j.key = war_reports_battles.id))
						 WHERE id IN (SELECT key FROM json_each(?))`,
					)
					.bind(ids, ids),
				api.db.prepare('DELETE FROM war_reports_battles WHERE refs = 0 AND id IN (SELECT key FROM json_each(?))').bind(ids),
			);
		};
		mail.onRemoved('war-reports.march', release);
		mail.onRemoved('war-reports.defense', release);
		/** The battle a mail tells of: its own copy (mails from before), else the shared row (read once per request). */
		const battleOf = (api: ReadApi, data: { battle?: string; report?: BattleReport }): Promise<BattleReport> => {
			if (data.report) return Promise.resolve(data.report);
			const id = data.battle;
			if (!id) throw new PluginError('war-reports: a mail without its battle');
			return api.memo(`war-reports:battle:${id}`, async () => {
				const row = await api.db.prepare('SELECT data FROM war_reports_battles WHERE id = ?').bind(id).first<{ data: string }>();
				if (!row) throw new PluginError(`war-reports: no battle ${id}`);
				return JSON.parse(row.data) as BattleReport;
			});
		};

		const settlementName = async (api: ReadApi, id: string | null): Promise<UiText> => {
			const s = id ? await settlements.get(api, id) : null;
			return s ? settlements.nameText(s) : literal('?');
		};

		ctx.services.get('armies').onArrive(async (api, { army, tile, at, report, cargo, deliverTo, station }) => {
			// Only a battle makes a report (user 2026-10-21: "只有'战斗'才发'战报'"): troops moved, supplies delivered,
			// a settlement founded show on their pages, not in the mailbox.
			if (report.outcome === 'no-battle') return;
			const where = {
				x: tile.x,
				y: tile.y,
				target: await settlementName(api, deliverTo),
				site: report.target.name ? settlements.nameText({ name: report.target.name }) : literal(`(${tile.x}, ${tile.y})`),
			};
			const title =
				army.mission === 'settle'
					? deliverTo
						? 'Settlement founded: {target}'
						: 'Expedition failed at ({x}, {y})'
					: army.mission === 'transfer'
						? station
							? 'Troops arrived at {target}'
							: deliverTo
								? 'Supplies delivered to {target}'
								: 'Transfer failed at ({x}, {y})'
						: army.mission === 'transport'
							? deliverTo
								? 'Supplies delivered to {target}'
								: report.note?.text === 'armies.Resources picked up'
									? 'Resources picked up at {site}'
									: 'Transport failed at ({x}, {y})'
							: report.outcome === 'victory'
								? 'Victory at ({x}, {y})'
								: report.outcome === 'defeat'
									? 'Defeat at ({x}, {y})'
									: 'Report from ({x}, {y})';
			mail.send(api, army.playerId, {
				kind: 'war-reports.march',
				title: text(title, where),
				at,
				data: {
					mission: army.mission,
					from: army.from,
					target: tile,
					units: army.units,
					cargo,
					battle: share(api, report, at),
					deliverTo,
					station,
				} satisfies MarchMail,
			});
		});

		ctx.services.get('pvp').onDefense(async (api, { defenderId, attackerId, settlementId, at, report }) => {
			// Bandits and other non-players are named in the report.
			const username = attackerId ? (await accounts.usernames(api.db, [attackerId]))[attackerId] : undefined;
			const attackerName = report.attacker ? keyText(report.attacker.name) : username ? literal(username) : null;
			mail.send(api, defenderId, {
				kind: 'war-reports.defense',
				// The report's outcome is the attacker's.
				title: text(report.outcome === 'victory' ? '{settlement} was raided by {name}' : '{settlement} repelled an attack by {name}', {
					settlement: await settlementName(api, settlementId),
					name: attackerName ?? literal('?'),
				}),
				at,
				data: { settlement: settlementId, attackerName, battle: share(api, report, at) } satisfies DefenseMail,
			});
		});

		ctx.services.get('troops').onShortage(async (api, { settlementId, resource, at, routed, downgraded }) => {
			const s = await settlements.get(api, settlementId);
			if (!s?.ownerId) return;
			const res = resources.list().find((r) => r.id === resource);
			mail.send(api, s.ownerId, {
				kind: 'war-reports.shortage',
				title: text(
					Object.keys(routed).length
						? 'Troops deserted {settlement}: out of {resource}'
						: 'Troops in {settlement} lost a tier: out of {resource}',
					{ settlement: settlements.nameText(s), resource: keyText(res?.name ?? resource) },
				),
				at,
				data: { settlement: settlementId, resource, routed, downgraded } satisfies ShortageMail,
			});
		});

		/* ----- reading ------------------------------------------------------------------- */

		// A battle's mail is shown in the browser (web/plugins/war-reports: the client part at "mail.report"): it gets the
		// battle its data points at and the reader's name for the lanes, as stored.
		const attached = async (api: ReadApi, message: MailMessage): Promise<WarReportAttached> => ({
			battle: await battleOf(api, message.data as MarchMail | DefenseMail),
			you: (await accounts.usernames(api.db, [api.playerId]))[api.playerId] ?? '?',
		});
		mail.attach('war-reports.march', attached);
		mail.attach('war-reports.defense', attached);

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.mail('war-reports.march', 'ui.report');
		ui.mail('war-reports.defense', 'ui.report');
		ui.mail('war-reports.shortage', 'ui.report');
	},
});
