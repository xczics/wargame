// The adventure report in the mailbox (generic `ui.report`): each group fought as a row, assembled in the browser from
// the mail's data (the server sends it as stored). Pure: the tests run it.
import type { MailMessage, RealmMail, RewardLine } from '../../../src/shared/api';
import { amount } from '../../../src/shared/format';
import { nameKey } from '../../../src/shared/heroes';
import { keyText, literal, rewardName, uiTexts } from '../../../src/shared/i18n';
import type { ReportData, UiLine, UiText } from '../../../src/shared/ui';

// The realms plugin's own words (its i18n keys).
const text = uiTexts('realms');

const rewardText = (l: RewardLine): UiText =>
	text(l.lost ? '{0}{1} {2}' : '{0}{1}', {
		0: rewardName(l),
		1: l.count && l.count > 1 ? ` ×${l.count}` : '',
		2: [text('(lost: bag full)')],
	});
/** A reward line as shown: its icon (an art icon too) before the words. */
const rewardLine = (l: RewardLine): UiLine => ({
	...(l.icon ? { icon: l.icon } : {}),
	text: rewardText(l),
	...(l.rarity ? { rarity: l.rarity } : {}),
});

/** An adventure's report. */
export function adventureReport(message: MailMessage): ReportData {
	const r = message.data as RealmMail;
	return {
		tone: r.injured ? 'bad' : 'good',
		lines: [
			{ text: text('{0} · {1} · {2}', { 0: nameKey(r.hero), 1: keyText(r.realmName), 2: keyText(r.taskName) }) },
			{
				text: text('Attack {a} · Defence {d} · HP {h} · Recovery {r}%', {
					a: amount(r.stats.attack),
					d: amount(r.stats.defense),
					h: amount(r.stats.hp),
					r: amount(r.stats.recovery, 1),
				}),
				tone: 'muted',
			},
		],
		lanes: {
			columns: [text('Group'), text('Attack / defence / HP'), text('Hero HP'), text(''), text('Rewards')],
			rows: r.groups.map((g) => ({
				label: text('{0}{1}', { 0: g.boss ? '👑 ' : '', 1: keyText(g.name) }),
				tone: g.won ? ('good' as const) : ('bad' as const),
				cells: [
					[{ text: literal(`${amount(g.attack)} / ${amount(g.defense)} / ${amount(g.hp)}`) }],
					[{ text: literal(`${amount(g.hpBefore)} → ${amount(g.hpAfter)}`) }],
					[{ text: text(g.won ? '✔' : '✘') }],
					g.rewards.map(rewardLine),
				],
			})),
		},
		fields: [
			{
				label: text('Experience'),
				value: [
					{
						text: r.levels ? text('+{0} · up {1} levels', { 0: amount(r.exp), 1: r.levels }) : literal(`+${amount(r.exp)}`),
					},
				],
			},
			...(r.clearRewards.length
				? [
						{
							label: text('Clear rewards'),
							value: r.clearRewards.map(rewardLine),
						},
					]
				: []),
		],
		...(r.injured ? { notes: [{ text: text('The hero fell and is injured: treat it at its settlement.'), tone: 'warn' as const }] } : {}),
	};
}
