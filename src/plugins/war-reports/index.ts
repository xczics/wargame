/**
 * War reports: turns what happens to a player's troops into mail.
 *
 *   war-reports.march     an army of theirs reached its target (battle, transfer, founding...)
 *   war-reports.defense   one of their settlements was attacked
 *   war-reports.shortage  upkeep ran out and troops left or dropped a tier
 *
 * The systems involved (armies, pvp, troops) only announce their events; this plugin decides
 * what the player is told. Each message is committed with the event itself. The mailbox shows
 * them as generic reports (`ui.report`, lanes as `ui.lanes`), presented here when read.
 *
 * A battle is stored once (`war_reports_battles`), however many reports tell of it (user 2026-10-21: "把战斗数据只存一份，
 * 两封信都只记一个战斗编号"): the attacker's and the defender's mail keep what is theirs and the battle's id. The row
 * counts the mails pointing at it and goes with the last of them (`mail.onRemoved`). Mails from before keep the whole
 * report in their own data (`report`) and are read from there.
 */
import { definePlugin, type EngineApi, PluginError, type ReadApi } from '../../kernel';
import type { BattleDetail, BattleReport, DefenseMail, MarchMail, RewardLine, ShortageMail } from '../../shared/api';
import { amount, signed } from '../../shared/format';
import type { LanesData, ReportData, UiField, UiLine, UiText } from '../../shared/ui';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, literal, rewardName, uiTexts } from '../../shared/i18n';

const text = uiTexts('war-reports');

export default definePlugin({
	id: 'war-reports',
	version: '0.1.0',
	description: 'Battle reports and troop notices, sent to the mailbox',
	dependsOn: ['mail', 'armies', 'pvp', 'troops', 'battle', 'settlements', 'resources', 'accounts', 'ui', 'i18n'],
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

		/* ----- presentation (generic reports) ------------------------------------------- */

		const troops = ctx.services.get('troops');
		const battle = ctx.services.get('battle');
		const unitName = (id: string) => keyText(troops.list().find((u) => u.id === id)?.name ?? id);
		const icons = () => Object.fromEntries(resources.list().map((r) => [r.id, r.icon ?? r.id]));
		const units = (u: Record<string, number>): UiText[] =>
			Object.entries(u)
				.filter(([, n]) => n > 0)
				.map(([id, n]) => text('{0} ×{1}', { 0: unitName(id), 1: amount(n) }));
		const goods = (c: Record<string, number>) => {
			const i = icons();
			return Object.entries(c)
				.filter(([, n]) => n > 0)
				.map(([r, n]) => `${i[r] ?? r}${amount(n)}`)
				.join(' ');
		};
		const promoted = (list: { from: string; to: string; count: number }[]): UiText[] =>
			list.map((p) => text('{0} → {1} ×{2}', { 0: unitName(p.from), 1: unitName(p.to), 2: amount(p.count) }));
		/** Fields with something in them, in order. */
		const fields = (...list: [UiText, UiText[] | string | undefined][]): UiField[] =>
			list.flatMap(([label, v]) =>
				!v || !v.length ? [] : [{ label, value: [{ text: typeof v === 'string' ? literal(v) : text('{0}', { 0: v }) }] }],
			);
		/** What was at the target: its name, else its kind (a settlement kind's name, or ours: "empty"...). */
		const targetText = (t: BattleReport['target']): UiText => settlements.labelOf(t);

		/** Things won (drops), each in its colour: a "Spoils" field, or none. */
		const spoilsField = (lines: RewardLine[] | undefined): UiField[] =>
			lines?.length
				? [
						{
							label: text('Spoils'),
							value: lines.map((l) => ({
								...(l.icon ? { icon: l.icon } : {}),
								text: text('{0}{1}', { 0: rewardName(l), 1: l.count && l.count > 1 ? ` ×${l.count}` : '' }),
								...(l.rarity ? { rarity: l.rarity } : {}),
							})),
						},
					]
				: [];
		/**
		 * A battle lane by lane, both sides by name (user 2026-10-21: "我倾向于直接写玩家用户名": the same wording whoever reads
		 * it), the attacker on the left; `side` is the reader's, only for the rows' colours.
		 */
		const lanes = (d: BattleDetail, side: 'attacker' | 'defender', names: Record<'attacker' | 'defender', UiText>): LanesData => {
			const families = new Map(battle.families().map((f) => [f.id, f]));
			const family = (id: string) => text('{0} {1}', { 0: families.get(id)?.icon ?? '', 1: keyText(families.get(id)?.name ?? id) });
			const cell = (l: BattleDetail['lanes'][number]['attacker']): UiLine[] => {
				const lost = Object.entries(l.lost)
					.filter(([, n]) => n > 0)
					.map(([id, n]) => text('{0} {1}', { 0: unitName(id), 1: amount(n, 1) }));
				return [
					{ text: text('{0} ×{1}', { 0: [family(l.family)], 1: amount(Object.values(l.units).reduce((a, b) => a + b, 0)) }) },
					// What the lane is made of, unit by unit (e.g. "Militia ×120; Spearmen ×40").
					...(units(l.units).length ? [{ text: text('{0}', { 0: units(l.units) }) }] : []),
					...(l.counters ? [{ text: text('counters'), tone: 'info' as const }] : []),
					{
						text: text('atk {0} · def {1} · hp {2}', { 0: amount(l.attack), 1: amount(l.defense), 2: amount(l.hp) }),
						tone: 'muted',
					},
					...(lost.length ? [{ text: text('−{0}', { 0: lost }), tone: 'warn' as const }] : []),
				];
			};
			const pct = (v: number) => signed(v, true, 1);
			const bonuses = (who: 'attacker' | 'defender'): UiLine[] =>
				d.modifiers[who].length
					? [
							{
								text: text('Bonuses of {0}: {1}', {
									0: names[who],
									1: d.modifiers[who].map((m) =>
										text('{0} {1} {2}', {
											0: m.source,
											1: text(m.stat),
											2: [m.flat ? `+${amount(m.flat)}` : '', m.percent ? pct(m.percent) : '', m.last ? `+${amount(m.last)}` : '']
												.filter(Boolean)
												.join(' '),
										}),
									),
								}),
								tone: 'muted',
							},
						]
					: [];
			return {
				title: text('Lane by lane'),
				summary: [
					{
						text: text('Result: {0} {1} ({2} lanes to {3}; losses ×{4} / ×{5})', {
							0: names.attacker,
							1: text(`grade:${d.grade.attacker}`),
							2: d.wins.attacker,
							3: d.wins.defender,
							4: amount(d.casualtyFactor.attacker, 2),
							5: amount(d.casualtyFactor.defender, 2),
						}),
						tone: 'muted',
					},
				],
				// The attacker always on the left, the defender on the right, whichever side we are (user 2026-10-21).
				columns: [text(''), text('Attacker: {0}', { 0: names.attacker }), text('Defender: {0}', { 0: names.defender })],
				rows: d.lanes.map((l, i) => ({
					label: text('Lane {0}', { 0: i + 1 }),
					tone: l.winner === side ? 'good' : 'bad',
					cells: [cell(l.attacker), cell(l.defender)],
				})),
				notes: [
					{ text: text('Lane losses are before the casualty factor; the totals above are after it.'), tone: 'muted' },
					...bonuses('attacker'),
					...bonuses('defender'),
				],
			};
		};
		const tone = (r: BattleReport): ReportData['tone'] => (r.outcome === 'victory' ? 'good' : r.outcome === 'defeat' ? 'bad' : undefined);

		mail.present('war-reports.march', async (api, message): Promise<ReportData> => {
			const m = message.data as MarchMail;
			const r = await battleOf(api, m);
			const target = targetText(r.target);
			return {
				tone: tone(r),
				badge: keyText(ctx.services.get('armies').missionName(m.mission)),
				lines: [
					{
						text: r.target.ownerName
							? text('{0} → ({1}, {2}) · {3} ({4})', {
									0: await settlementName(api, m.from),
									1: m.target.x,
									2: m.target.y,
									3: target,
									4: literal(r.target.ownerName),
								})
							: text('{0} → ({1}, {2}) · {3}', { 0: await settlementName(api, m.from), 1: m.target.x, 2: m.target.y, 3: target }),
					},
					{
						text: text('{0}', {
							0: [
								...(r.outcome !== 'no-battle' || m.mission === 'attack' ? [text(r.outcome)] : []),
								...(r.note ? [r.note] : []),
								...(r.outcome !== 'no-battle' ? [text('attack {a} vs defence {d}', { a: amount(r.attack), d: amount(r.defense) })] : []),
							],
						}),
					},
				],
				fields: [
					...fields([text('Troops'), units(m.units).length ? units(m.units) : '—']),
					...fields(
						[text(m.deliverTo ? 'Supplies delivered' : 'Supplies brought back'), goods(m.cargo ?? {})],
						[text('Losses'), units(r.losses.attacker)],
						[text('Enemy losses'), units(r.losses.defender)],
						[text(m.mission === 'transport' ? 'Brought back' : 'Loot'), goods(r.loot)],
						[text('Captured'), units(r.captured)],
						[text('Promoted'), promoted(r.promoted?.attacker ?? [])],
					),
					...spoilsField(r.spoils),
				],
				...(r.battle
					? {
							lanes: lanes(r.battle, 'attacker', {
								attacker: literal((await accounts.usernames(api.db, [api.playerId]))[api.playerId] ?? '?'),
								defender: r.target.ownerName ? literal(r.target.ownerName) : target,
							}),
						}
					: {}),
			};
		});

		mail.present('war-reports.defense', async (api, message): Promise<ReportData> => {
			const d = message.data as DefenseMail;
			const r = await battleOf(api, d);
			// The report's outcome is the attacker's.
			const held = r.outcome !== 'victory';
			const name = d.attackerName ?? text('Someone');
			const attacker = r.attacker?.level ? text('{name} (Lv {n})', { name, n: r.attacker.level }) : name;
			return {
				tone: held ? 'good' : 'bad',
				lines: [
					{
						text: text('{0} · {1} ← {2}', {
							0: [text(held ? 'The attack was repelled' : 'The attackers won')],
							1: await settlementName(api, d.settlement),
							2: [attacker],
						}),
					},
				],
				fields: [
					...fields(
						[text('Lost'), units(r.losses.defender)],
						[text('Enemy losses'), units(r.losses.attacker)],
						[text('Taken'), goods(r.loot)],
					),
					...(r.prestige
						? [
								{
									label: text('Prestige'),
									value: [
										{
											text: literal(`${r.prestige > 0 ? '+' : ''}${amount(r.prestige, 2)}`),
											tone: r.prestige > 0 ? ('info' as const) : ('warn' as const),
										},
									],
								},
							]
						: []),
					...spoilsField(r.rewards),
					...fields([text('Promoted'), promoted(r.promoted?.defender ?? [])]),
				],
				...(r.battle
					? {
							lanes: lanes(r.battle, 'defender', {
								attacker,
								defender: literal((await accounts.usernames(api.db, [api.playerId]))[api.playerId] ?? '?'),
							}),
						}
					: {}),
			};
		});

		mail.present('war-reports.shortage', async (api, message): Promise<ReportData> => {
			const s = message.data as ShortageMail;
			const res = resources.list().find((r) => r.id === s.resource);
			return {
				tone: 'bad',
				lines: [
					{
						text: text('{0} · {1}', {
							0: await settlementName(api, s.settlement),
							1: [text('Out of {resource}', { resource: [text('{0}{1}', { 0: res?.icon ?? '', 1: keyText(res?.name ?? s.resource) })] })],
						}),
					},
				],
				fields: fields([text('Deserted'), units(s.routed)], [text('Dropped a tier'), promoted(s.downgraded)]),
				notes: [{ text: text('Until income covers upkeep again, a little more leaves every round.'), tone: 'muted' }],
			};
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.mail('war-reports.march', 'ui.report');
		ui.mail('war-reports.defense', 'ui.report');
		ui.mail('war-reports.shortage', 'ui.report');
	},
});
