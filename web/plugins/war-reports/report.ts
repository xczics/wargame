// War reports as the mailbox shows them (generic `ui.report`), assembled in the browser from the mail's data and the
// battle the server attaches (AGENTS.md: the server forwards data; the words, numbers and lanes are put together here).
// Names come from the meta (units, resources, troop families, missions, settlement kinds) and the player's settlements
// (`settlements.mine`, synced on every page). Pure: the tests run it.
import type {
	BattleDetail,
	BattleReport,
	DefenseMail,
	MailMessage,
	MarchMail,
	Meta,
	RewardLine,
	SettlementSummary,
	ShortageMail,
	WarReportAttached,
} from '../../../src/shared/api';
import type { ClientViewGet } from '../../../src/shared/client-views';
import { amount, readable, signed } from '../../../src/shared/format';
import { keyText, literal, rewardName, uiTexts } from '../../../src/shared/i18n';
import type { LanesData, ReportData, UiField, UiLine, UiText } from '../../../src/shared/ui';

// The war-reports plugin's own words (its i18n keys).
const text = uiTexts('war-reports');

/** The names a report needs, from the meta and the player's settlements. */
function namesOf(get: ClientViewGet) {
	const units = new Map((get.meta<Meta['units']>('units') ?? []).map((u) => [u.id, u.name]));
	const resources = get.meta<Meta['resources']>('resources') ?? [];
	const icons = Object.fromEntries(resources.map((r) => [r.id, r.icon ?? r.id]));
	const families = new Map((get.meta<Meta['battleFamilies']>('battleFamilies') ?? []).map((f) => [f.id, f]));
	const kinds = new Map((get.meta<Meta['settlementKinds']>('settlementKinds') ?? []).map((k) => [k.id, k.name]));
	const mine = get.data<SettlementSummary[]>('settlements.mine') ?? [];
	const unitName = (id: string) => keyText(units.get(id) ?? id);
	const units_ = (u: Record<string, number>): UiText[] =>
		Object.entries(u)
			.filter(([, n]) => n > 0)
			.map(([id, n]) => text('{0} ×{1}', { 0: unitName(id), 1: amount(n) }));
	return {
		unitName,
		units: units_,
		goods: (c: Record<string, number>) =>
			Object.entries(c)
				.filter(([, n]) => n > 0)
				.map(([r, n]) => `${icons[r] ?? r}${amount(n)}`)
				.join(' '),
		promoted: (list: { from: string; to: string; count: number }[]): UiText[] =>
			list.map((p) => text('{0} → {1} ×{2}', { 0: unitName(p.from), 1: unitName(p.to), 2: amount(p.count) })),
		family: (id: string) => text('{0} {1}', { 0: families.get(id)?.icon ?? '', 1: keyText(families.get(id)?.name ?? id) }),
		// One of the player's own (its kind's name until renamed, else the name as typed); gone since: "?".
		settlement: (id: string | null): UiText => {
			const s = id ? mine.find((x) => x.id === id) : undefined;
			return s ? { text: s.name } : literal('?');
		},
		// What was at a battle's target: its name, else what kind of settlement it is.
		target: (t: BattleReport['target']): UiText =>
			t.name ? { text: t.name } : kinds.has(t.kind) ? keyText(kinds.get(t.kind)!) : literal(t.kind),
		resource: (id: string) => resources.find((r) => r.id === id),
		mission: (id: string) => get.meta<Record<string, string>>('armyMissions')?.[id] ?? id,
	};
}
type Names = ReturnType<typeof namesOf>;

/** Fields with something in them, in order. */
const fields = (...list: [UiText, UiText[] | string | undefined][]): UiField[] =>
	list.flatMap(([label, v]) =>
		!v || !v.length ? [] : [{ label, value: [{ text: typeof v === 'string' ? literal(v) : text('{0}', { 0: v }) }] }],
	);

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
function lanes(n: Names, d: BattleDetail, side: 'attacker' | 'defender', names: Record<'attacker' | 'defender', UiText>): LanesData {
	const cell = (l: BattleDetail['lanes'][number]['attacker']): UiLine[] => {
		const lost = Object.entries(l.lost)
			.filter(([, x]) => x > 0)
			.map(([id, x]) => text('{0} {1}', { 0: n.unitName(id), 1: readable(x) }));
		return [
			{ text: text('{0} ×{1}', { 0: [n.family(l.family)], 1: amount(Object.values(l.units).reduce((a, b) => a + b, 0)) }) },
			// What the lane is made of, unit by unit (e.g. "Militia ×120; Spearmen ×40").
			...(n.units(l.units).length ? [{ text: text('{0}', { 0: n.units(l.units) }) }] : []),
			...(l.counters ? [{ text: text('counters'), tone: 'info' as const }] : []),
			{ text: text('atk {0} · def {1} · hp {2}', { 0: amount(l.attack), 1: amount(l.defense), 2: amount(l.hp) }), tone: 'muted' },
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
}

const tone = (r: BattleReport): ReportData['tone'] => (r.outcome === 'victory' ? 'good' : r.outcome === 'defeat' ? 'bad' : undefined);

/** One of the player's armies reached its target. */
export function marchReport(message: MailMessage, get: ClientViewGet): ReportData | undefined {
	const at = message.attached as WarReportAttached | undefined;
	if (!at) return undefined;
	const n = namesOf(get);
	const m = message.data as MarchMail;
	const r = at.battle;
	const target = n.target(r.target);
	return {
		tone: tone(r),
		badge: keyText(n.mission(m.mission)),
		lines: [
			{
				text: r.target.ownerName
					? text('{0} → ({1}, {2}) · {3} ({4})', {
							0: n.settlement(m.from),
							1: m.target.x,
							2: m.target.y,
							3: target,
							4: literal(r.target.ownerName),
						})
					: text('{0} → ({1}, {2}) · {3}', { 0: n.settlement(m.from), 1: m.target.x, 2: m.target.y, 3: target }),
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
			...fields([text('Troops'), n.units(m.units).length ? n.units(m.units) : '—']),
			...fields(
				[text(m.deliverTo ? 'Supplies delivered' : 'Supplies brought back'), n.goods(m.cargo ?? {})],
				[text('Losses'), n.units(r.losses.attacker)],
				[text('Enemy losses'), n.units(r.losses.defender)],
				[text(m.mission === 'transport' ? 'Brought back' : 'Loot'), n.goods(r.loot)],
				[text('Captured'), n.units(r.captured)],
				[text('Promoted'), n.promoted(r.promoted?.attacker ?? [])],
			),
			...spoilsField(r.spoils),
		],
		...(r.battle
			? {
					lanes: lanes(n, r.battle, 'attacker', {
						attacker: literal(at.you),
						defender: r.target.ownerName ? literal(r.target.ownerName) : target,
					}),
				}
			: {}),
	};
}

/** One of the player's settlements was attacked. */
export function defenseReport(message: MailMessage, get: ClientViewGet): ReportData | undefined {
	const at = message.attached as WarReportAttached | undefined;
	if (!at) return undefined;
	const n = namesOf(get);
	const d = message.data as DefenseMail;
	const r = at.battle;
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
					1: n.settlement(d.settlement),
					2: [attacker],
				}),
			},
		],
		fields: [
			...fields(
				[text('Lost'), n.units(r.losses.defender)],
				[text('Enemy losses'), n.units(r.losses.attacker)],
				[text('Taken'), n.goods(r.loot)],
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
			...fields([text('Promoted'), n.promoted(r.promoted?.defender ?? [])]),
		],
		...(r.battle ? { lanes: lanes(n, r.battle, 'defender', { attacker, defender: literal(at.you) }) } : {}),
	};
}

/** Upkeep ran out somewhere: troops left or dropped a tier. */
export function shortageReport(message: MailMessage, get: ClientViewGet): ReportData {
	const n = namesOf(get);
	const s = message.data as ShortageMail;
	const res = n.resource(s.resource);
	return {
		tone: 'bad',
		lines: [
			{
				text: text('{0} · {1}', {
					0: n.settlement(s.settlement),
					1: [text('Out of {resource}', { resource: [text('{0}{1}', { 0: res?.icon ?? '', 1: keyText(res?.name ?? s.resource) })] })],
				}),
			},
		],
		fields: fields([text('Deserted'), n.units(s.routed)], [text('Dropped a tier'), n.promoted(s.downgraded)]),
		notes: [{ text: text('Until income covers upkeep again, a little more leaves every round.'), tone: 'muted' }],
	};
}
