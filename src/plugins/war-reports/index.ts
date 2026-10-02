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
 */
import { definePlugin, type ReadApi } from '../../kernel';
import type { BattleDetail, BattleReport, DefenseMail, MarchMail, ShortageMail } from '../../shared/api';
import { amount } from '../../shared/format';
import type { LanesData, ReportData, UiField, UiLine, UiText } from '../../shared/ui';
import i18nCsv from './data/i18n.csv?raw';

export default definePlugin({
	id: 'war-reports',
	version: '0.1.0',
	description: 'Battle reports and troop notices, sent to the mailbox',
	dependsOn: ['mail', 'armies', 'pvp', 'troops', 'battle', 'settlements', 'resources', 'accounts', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv);
		const mail = ctx.services.get('mail');
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const accounts = ctx.services.get('accounts');
		const nameOf = async (api: Parameters<typeof settlements.get>[0], id: string | null) =>
			(id ? (await settlements.get(api, id))?.name : null) ?? '?';

		ctx.services.get('armies').onArrive(async (api, { army, tile, at, report, cargo, deliverTo, station }) => {
			const where = { x: tile.x, y: tile.y, target: await nameOf(api, deliverTo), site: report.target.name ?? `(${tile.x}, ${tile.y})` };
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
								: report.note === 'Resources picked up'
									? 'Resources picked up at {site}'
									: 'Transport failed at ({x}, {y})'
							: report.outcome === 'victory'
								? 'Victory at ({x}, {y})'
								: report.outcome === 'defeat'
									? 'Defeat at ({x}, {y})'
									: 'Report from ({x}, {y})';
			mail.send(api, army.playerId, {
				kind: 'war-reports.march',
				title,
				vars: where,
				at,
				data: {
					mission: army.mission,
					from: army.from,
					target: tile,
					units: army.units,
					cargo,
					report,
					deliverTo,
					station,
				} satisfies MarchMail,
			});
		});

		ctx.services.get('pvp').onDefense(async (api, { defenderId, attackerId, settlementId, at, report }) => {
			// Bandits and other non-players are named in the report.
			const attackerName =
				report.attacker?.name ?? (attackerId ? ((await accounts.usernames(api.db, [attackerId]))[attackerId] ?? null) : null);
			mail.send(api, defenderId, {
				kind: 'war-reports.defense',
				// The report's outcome is the attacker's.
				title: report.outcome === 'victory' ? '{settlement} was raided by {name}' : '{settlement} repelled an attack by {name}',
				vars: { settlement: await nameOf(api, settlementId), name: attackerName ?? '?' },
				at,
				data: { settlement: settlementId, attackerName, report } satisfies DefenseMail,
			});
		});

		ctx.services.get('troops').onShortage(async (api, { settlementId, resource, at, routed, downgraded }) => {
			const s = await settlements.get(api, settlementId);
			if (!s?.ownerId) return;
			const res = resources.list().find((r) => r.id === resource);
			mail.send(api, s.ownerId, {
				kind: 'war-reports.shortage',
				title: Object.keys(routed).length
					? 'Troops deserted {settlement}: out of {resource}'
					: 'Troops in {settlement} lost a tier: out of {resource}',
				vars: { settlement: s.name, resource: res?.name ?? resource },
				at,
				data: { settlement: settlementId, resource, routed, downgraded } satisfies ShortageMail,
			});
		});

		/* ----- presentation (generic reports) ------------------------------------------- */

		const troops = ctx.services.get('troops');
		const battle = ctx.services.get('battle');
		const unitName = (id: string) => troops.list().find((u) => u.id === id)?.name ?? id;
		const icons = () => Object.fromEntries(resources.list().map((r) => [r.id, r.icon ?? r.id]));
		const units = (u: Record<string, number>): UiText[] =>
			Object.entries(u)
				.filter(([, n]) => n > 0)
				.map(([id, n]) => ({ text: '{0} ×{1}', vars: { 0: unitName(id), 1: amount(n) } }));
		const goods = (c: Record<string, number>) => {
			const i = icons();
			return Object.entries(c)
				.filter(([, n]) => n > 0)
				.map(([r, n]) => `${i[r] ?? r}${amount(n)}`)
				.join(' ');
		};
		const promoted = (list: { from: string; to: string; count: number }[]): UiText[] =>
			list.map((p) => ({ text: '{0} → {1} ×{2}', vars: { 0: unitName(p.from), 1: unitName(p.to), 2: amount(p.count) } }));
		/** Fields with something in them, in order. */
		const fields = (...list: [UiText, UiText[] | string | undefined][]): UiField[] =>
			list.flatMap(([label, v]) =>
				!v || !v.length ? [] : [{ label, value: [{ text: typeof v === 'string' ? { text: v } : { text: '{0}', vars: { 0: v } } }] }],
			);
		const settlementName = async (api: ReadApi, id: string | null) => (id ? ((await settlements.get(api, id))?.name ?? '?') : '?');

		/** A battle lane by lane, seen from `side` ("us"). */
		const lanes = (d: BattleDetail, side: 'attacker' | 'defender'): LanesData => {
			const other = side === 'attacker' ? 'defender' : 'attacker';
			const families = new Map(battle.families().map((f) => [f.id, f]));
			const family = (id: string) => ({ text: '{0} {1}', vars: { 0: families.get(id)?.icon ?? '', 1: families.get(id)?.name ?? id } });
			const cell = (l: BattleDetail['lanes'][number]['attacker']): UiLine[] => {
				const lost = Object.entries(l.lost)
					.filter(([, n]) => n > 0)
					.map(([id, n]) => ({ text: '{0} {1}', vars: { 0: unitName(id), 1: amount(n, 1) } }));
				return [
					{ text: { text: '{0} ×{1}', vars: { 0: [family(l.family)], 1: amount(Object.values(l.units).reduce((a, b) => a + b, 0)) } } },
					// What the lane is made of, unit by unit (e.g. "Militia ×120; Spearmen ×40").
					...(units(l.units).length ? [{ text: { text: '{0}', vars: { 0: units(l.units) } } }] : []),
					...(l.counters ? [{ text: { text: 'counters' }, tone: 'info' as const }] : []),
					{
						text: { text: 'atk {0} · def {1} · hp {2}', vars: { 0: amount(l.attack), 1: amount(l.defense), 2: amount(l.hp) } },
						tone: 'muted',
					},
					...(lost.length ? [{ text: { text: '−{0}', vars: { 0: lost } }, tone: 'warn' as const }] : []),
				];
			};
			const pct = (v: number) => `${v > 0 ? '+' : ''}${amount(v, 1)}%`;
			const bonuses = (who: 'attacker' | 'defender'): UiLine[] =>
				d.modifiers[who].length
					? [
							{
								text: {
									text: who === side ? 'Our bonuses: {0}' : 'Their bonuses: {0}',
									vars: {
										0: d.modifiers[who].map((m) => ({
											text: '{0} {1} {2}',
											vars: {
												0: m.source,
												1: m.stat,
												2: [m.flat ? `+${amount(m.flat)}` : '', m.percent ? pct(m.percent) : ''].filter(Boolean).join(' '),
											},
										})),
									},
								},
								tone: 'muted',
							},
						]
					: [];
			return {
				title: { text: 'Lane by lane' },
				summary: [
					{
						text: {
							text: 'Result: {0} ({1} lanes to {2}, losses ×{3})',
							vars: { 0: `grade:${d.grade[side]}`, 1: d.wins[side], 2: d.wins[other], 3: amount(d.casualtyFactor[side], 2) },
						},
						tone: 'muted',
					},
				],
				columns: [{ text: '' }, { text: 'Us' }, { text: 'Them' }],
				rows: d.lanes.map((l, i) => ({
					label: { text: 'Lane {0}', vars: { 0: i + 1 } },
					tone: l.winner === side ? 'good' : 'bad',
					cells: [cell(l[side]), cell(l[other])],
				})),
				notes: [
					{ text: { text: 'Lane losses are before the casualty factor; the totals above are after it.' }, tone: 'muted' },
					...bonuses(side),
					...bonuses(other),
				],
			};
		};
		const tone = (r: BattleReport): ReportData['tone'] => (r.outcome === 'victory' ? 'good' : r.outcome === 'defeat' ? 'bad' : undefined);

		mail.present('war-reports.march', async (api, message): Promise<ReportData> => {
			const m = message.data as MarchMail;
			const r = m.report;
			const target = r.target.name ?? r.target.kind;
			return {
				tone: tone(r),
				badge: { text: `mission:${m.mission}` },
				lines: [
					{
						text: r.target.ownerName
							? {
									text: '{0} → ({1}, {2}) · {3} ({4})',
									vars: { 0: await settlementName(api, m.from), 1: m.target.x, 2: m.target.y, 3: target, 4: r.target.ownerName },
								}
							: { text: '{0} → ({1}, {2}) · {3}', vars: { 0: await settlementName(api, m.from), 1: m.target.x, 2: m.target.y, 3: target } },
					},
					{
						text: {
							text: '{0}',
							vars: {
								0: [
									...(r.outcome !== 'no-battle' || m.mission === 'attack' ? [{ text: r.outcome }] : []),
									...(r.note ? [{ text: r.note }] : []),
									...(r.outcome !== 'no-battle'
										? [{ text: 'attack {a} vs defence {d}', vars: { a: amount(r.attack), d: amount(r.defense) } }]
										: []),
								],
							},
						},
					},
				],
				fields: [
					...fields([{ text: 'Troops' }, units(m.units).length ? units(m.units) : '—']),
					...fields(
						[{ text: m.deliverTo ? 'Supplies delivered' : 'Supplies brought back' }, goods(m.cargo ?? {})],
						[{ text: 'Losses' }, units(r.losses.attacker)],
						[{ text: 'Enemy losses' }, units(r.losses.defender)],
						[{ text: m.mission === 'transport' ? 'Brought back' : 'Loot' }, goods(r.loot)],
						[{ text: 'Captured' }, units(r.captured)],
						[{ text: 'Promoted' }, promoted(r.promoted?.attacker ?? [])],
					),
				],
				...(r.battle ? { lanes: lanes(r.battle, 'attacker') } : {}),
			};
		});

		mail.present('war-reports.defense', async (api, message): Promise<ReportData> => {
			const d = message.data as DefenseMail;
			const r = d.report;
			// The report's outcome is the attacker's.
			const held = r.outcome !== 'victory';
			const name = d.attackerName ?? 'Someone';
			const attacker = r.attacker?.level ? { text: '{name} (Lv {n})', vars: { name, n: r.attacker.level } } : { text: name };
			return {
				tone: held ? 'good' : 'bad',
				lines: [
					{
						text: {
							text: '{0} · {1} ← {2}',
							vars: {
								0: [{ text: held ? 'The attack was repelled' : 'The attackers won' }],
								1: await settlementName(api, d.settlement),
								2: [attacker],
							},
						},
					},
				],
				fields: [
					...fields(
						[{ text: 'Lost' }, units(r.losses.defender)],
						[{ text: 'Enemy losses' }, units(r.losses.attacker)],
						[{ text: 'Taken' }, goods(r.loot)],
					),
					...(r.prestige
						? [
								{
									label: { text: 'Prestige' },
									value: [
										{
											text: { text: `${r.prestige > 0 ? '+' : ''}${amount(r.prestige, 2)}` },
											tone: r.prestige > 0 ? ('info' as const) : ('warn' as const),
										},
									],
								},
							]
						: []),
					...(r.rewards?.length
						? [
								{
									label: { text: 'Spoils' },
									value: r.rewards.map((l) => ({
										text: { text: '{0}{1}{2}', vars: { 0: l.icon ?? '', 1: l.name, 2: l.count && l.count > 1 ? ` ×${l.count}` : '' } },
										...(l.rarity ? { rarity: l.rarity } : {}),
									})),
								},
							]
						: []),
					...fields([{ text: 'Promoted' }, promoted(r.promoted?.defender ?? [])]),
				],
				...(r.battle ? { lanes: lanes(r.battle, 'defender') } : {}),
			};
		});

		mail.present('war-reports.shortage', async (api, message): Promise<ReportData> => {
			const s = message.data as ShortageMail;
			const res = resources.list().find((r) => r.id === s.resource);
			return {
				tone: 'bad',
				lines: [
					{
						text: {
							text: '{0} · {1}',
							vars: {
								0: await settlementName(api, s.settlement),
								1: [
									{
										text: 'Out of {resource}',
										vars: { resource: [{ text: '{0}{1}', vars: { 0: res?.icon ?? '', 1: res?.name ?? s.resource } }] },
									},
								],
							},
						},
					},
				],
				fields: fields([{ text: 'Deserted' }, units(s.routed)], [{ text: 'Dropped a tier' }, promoted(s.downgraded)]),
				notes: [{ text: { text: 'Until income covers upkeep again, a little more leaves every round.' }, tone: 'muted' }],
			};
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.mail('war-reports.march', 'ui.report');
		ui.mail('war-reports.defense', 'ui.report');
		ui.mail('war-reports.shortage', 'ui.report');
	},
});
