// The wall's entry for the generic widgets, assembled in the browser (AGENTS.md: the server sends data only) from the
// wall's works, defences and orders (`starter-siege.wall`). Pure: the tests run it. What is being built (timers,
// `starter-siege.queue`), then the works and defences with what each gives and costs (rows, `starter-siege.rows`).
import type { Meta, SiegeWall } from '../../../src/shared/api';
import { amount, amounts, duration, resourceIcons } from '../../../src/shared/format';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import type { RowsData, TimersData, UiRow, UiText } from '../../../src/shared/ui';

// The starter-siege plugin's own words (its i18n keys): the entry reads as it did when the server built it.
const text = uiTexts('starter-siege');

const pct = (v: number) => `${v > 0 ? '+' : '−'}${Math.abs(v)}%`;

export function wallQueue(w: SiegeWall | null | undefined, resources: NonNullable<Meta['resources']>): TimersData | null | undefined {
	if (w === undefined) return undefined;
	if (!w || (!w.queue && !w.waiting.length)) return null;
	const ic = resourceIcons(resources);
	const label = (o: { kind: 'device' | 'work'; item: string; amount: number }): UiText => {
		const name = (o.kind === 'work' ? w.works : w.devices).find((x) => x.id === o.item)?.name;
		const item = name ? keyText(name) : text(o.item);
		return o.kind === 'work' ? text('{item} Lv {n}', { item, n: o.amount }) : text('{item} ×{n}', { item, n: o.amount });
	};
	// The one being built counts down; those waiting can be cancelled for their cost.
	return {
		items: [
			...(w.queue
				? [
						{
							id: w.queue.id,
							title: text('Building: {0}', { 0: label(w.queue) }),
							startedAt: w.queue.startedAt,
							endsAt: w.queue.finishesAt,
						},
					]
				: []),
			...w.waiting.map((j) => ({
				id: j.id,
				title: label(j),
				lines: [{ text: text('Waiting · {cost}', { cost: amounts(j.cost, ic) }), tone: 'muted' as const }],
				actions: [
					{
						command: 'starter-siege.cancel',
						payload: { settlement: w.settlement, id: j.id },
						label: text('Cancel (refund)'),
						confirm: text('Cancel this order? Its cost comes back.'),
					},
				],
			})),
		],
	};
}

export function wallRows(w: SiegeWall | null | undefined, resources: NonNullable<Meta['resources']>): RowsData | null | undefined {
	if (w === undefined) return undefined;
	if (!w) return null;
	const ic = resourceIcons(resources);
	return {
		sections: [
			{
				title: text('Wall works'),
				rows: w.works.map((x): UiRow => {
					const effect = text(`stat:${x.effect}`);
					// The next order builds the level after those queued, at the rules' cost (1.4.1: the card showed the next
					// built level's content cost, so with one queued an order cost more than it said).
					return {
						id: x.id,
						icon: x.icon,
						title: keyText(x.name),
						badge: text('Lv {n}/{max}', { n: x.level, max: x.maxLevel }),
						lines: [
							...(x.level ? [{ text: text('{effect} {value}', { effect, value: pct(x.value) }) }] : []),
							...(x.planned > x.level ? [{ text: text('Queued up to Lv {n}', { n: x.planned }), tone: 'muted' as const }] : []),
							...(x.next
								? [
										{
											text: text('next: {effect} {value} · {cost} · {t}', {
												effect,
												value: pct(x.next.value),
												cost: amounts(x.next.cost, ic),
												t: duration(x.next.time),
											}),
											tone: 'muted' as const,
										},
									]
								: []),
						],
					};
				}),
			},
			{
				title: text('Siege defences'),
				rows: w.devices.map((d): UiRow => ({
					id: d.id,
					icon: d.icon,
					title: d.count ? text('{item} ×{n}', { item: keyText(d.name), n: d.count }) : keyText(d.name),
					lines: [
						{
							text: text('each: {effect} +{value} · {cost} · {t} · keep {upkeep}/h', {
								effect: text(`stat:${d.stat}`),
								value: amount(d.value),
								cost: amounts(d.cost, ic),
								t: duration(d.time),
								upkeep: amounts(d.upkeep, ic, 2),
							}),
							tone: 'muted' as const,
						},
						...(d.wall > w.wall ? [{ text: text('needs wall Lv {n}', { n: d.wall }), tone: 'muted' as const }] : []),
					],
					locked: d.wall > w.wall,
				})),
			},
		],
		notes: amounts(w.upkeep, ic) ? [{ text: text('Upkeep: {upkeep}/h', { upkeep: amounts(w.upkeep, ic, 1) }) }] : [],
	};
}
