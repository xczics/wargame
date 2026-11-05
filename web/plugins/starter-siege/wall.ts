// The wall's entry for the generic widgets, assembled in the browser (AGENTS.md: the server sends data only) from the
// wall's works, defences and orders (`starter-siege.wall`). Pure: the tests run it. What is being built (timers,
// `starter-siege.queue`), then the works and defences with what each gives and costs (rows, `starter-siege.rows`).
import type { Meta, SiegeWall } from '../../../src/shared/api';
import { amount, duration, signed } from '../../../src/shared/format';
import { addUpkeep, wallUpkeep } from '../../../src/shared/siege';
import { costVar, isFree, keyText, literal, uiTexts, withIcon } from '../../../src/shared/i18n';
import type { RowsData, TimersData, UiRow, UiText } from '../../../src/shared/ui';

// The starter-siege plugin's own words (its i18n keys): the entry reads as it did when the server built it.
const text = uiTexts('starter-siege');

const pct = (v: number) => `${v > 0 ? '+' : '−'}${Math.abs(v)}%`;

export function wallQueue(w: SiegeWall | null | undefined, resources: NonNullable<Meta['resources']>): TimersData | null | undefined {
	if (w === undefined) return undefined;
	if (!w || (!w.queue && !w.waiting.length)) return null;
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
				lines: [{ text: text('Waiting · {cost}', { cost: costVar(j.cost, resources) }), tone: 'muted' as const }],
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

export function wallRows(
	w: SiegeWall | null | undefined,
	resources: NonNullable<Meta['resources']>,
	/** The settlement's kind: its wall rule (resource fortresses: x3, half the upkeep, no currency), whether troops stand there. */
	here: {
		rule?: { strength: number; upkeep: number; noGold: number };
		/** Each work's upkeep by level (the baked rules): the wall's whole upkeep, as charged, is worked out here. */
		works?: Record<string, Record<string, number>[]>;
		garrison: boolean;
		/** Other plugins' percent on the defences' strength (research), when the browser knows it; absent: not known. */
		known?: { percent: number; source: UiText }[];
		/** What other plugins take off the wall's upkeep, % by resource ("" = all; e.g. the Shuangqing Temple's research). */
		cuts?: { source: UiText; percent: Record<string, number> }[];
	} = { garrison: true },
): RowsData | null | undefined {
	if (w === undefined) return undefined;
	if (!w) return null;
	const { strength: kindStrength = 1, upkeep = 1, noGold = 0 } = here.rule ?? {};
	// The stat as the server has it: (1 + the kind's) x (1 + the percents); the percents only when the browser knows them.
	const percent = (here.known ?? []).reduce((n, k) => n + k.percent, 0);
	const strength = kindStrength * (1 + percent / 100);
	const icons = Object.fromEntries(resources.flatMap((r) => (r.icon ? [[r.id, r.icon]] : [])));
	// Each cut as the upkeep goes down by it (÷ (1 + p%)): "−9.1%", or by resource with its icon.
	const cutTexts = (here.cuts ?? []).map((c) =>
		text('{0} {1}', {
			0: c.source,
			1: Object.entries(c.percent).map(([r, p]) => {
				const off = signed(-(1 - 1 / (1 + p / 100)) * 100, true, 1);
				return r && icons[r] ? withIcon(icons[r], off) : literal(off);
			}),
		}),
	);
	// Flat hp only buffers a lane's troops: where none stand, the hp defences guard no one (not offered; those built show).
	const devices = w.devices.filter((d) => here.garrison || d.stat !== 'hp' || d.count > 0);
	// The wall's whole upkeep before the kind's rule (each defence x how many, each work at its level), as the server adds
	// it up: the currency is shared out over the other resources in its proportions, the rows' too.
	const raw: Record<string, number> = {};
	for (const d of w.devices) addUpkeep(raw, d.upkeep, d.count);
	for (const x of w.works) if (x.level) addUpkeep(raw, here.works?.[x.id]?.[x.level - 1] ?? {});
	const total = here.works ? wallUpkeep(raw, here.rule) : w.upkeep;
	// A row's currency goes as the whole wall's would with it there: as it is, or with one more of a defence not built.
	const shares = (d: { upkeep: Record<string, number>; count: number }) => (d.count ? raw : addUpkeep({ ...raw }, d.upkeep));
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
												cost: costVar(x.next.cost, resources),
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
				// What this settlement does to them (resource fortresses: x3, half the upkeep, no currency; user 2026-11-05:
				// "这边怎么看到的属性和普通城池是一样的"): said once, and each row at its numbers here.
				intro: [
					...(strength !== 1 || (!here.known && kindStrength !== 1)
						? [
								{
									text: here.known
										? percent
											? text('Here: each defence gives ×{0} (with {1} {2})', {
													0: amount(strength, 2),
													1: here.known.filter((k) => k.percent).map((k) => k.source),
													2: signed(percent, true, 1),
												})
											: text('Here: each defence gives ×{0}', { 0: amount(strength, 2) })
										: text('Here: each defence gives ×{0} (research bonuses on top)', { 0: amount(strength, 2) }),
									tone: 'info' as const,
								},
							]
						: []),
					...(upkeep !== 1 || noGold
						? [
								{
									text: text(noGold ? 'Here: their upkeep ×{0}, no currency' : 'Here: their upkeep ×{0}', {
										0: amount(upkeep, 2),
									}),
									tone: 'info' as const,
								},
							]
						: []),
				],
				rows: devices.map((d): UiRow => ({
					id: d.id,
					icon: d.icon,
					title: d.count ? text('{item} ×{n}', { item: keyText(d.name), n: d.count }) : keyText(d.name),
					lines: [
						{
							text: text('each: {effect} +{value} · {cost} · {t} · keep {upkeep}/h', {
								effect: text(`stat:${d.stat}`),
								value: amount(d.value * strength),
								cost: costVar(d.cost, resources),
								t: duration(d.time),
								upkeep: costVar(wallUpkeep(d.upkeep, here.rule, shares(d)), resources, { decimals: 2 }),
							}),
							tone: 'muted' as const,
						},
						...(d.wall > w.wall ? [{ text: text('needs wall Lv {n}', { n: d.wall }), tone: 'muted' as const }] : []),
					],
					locked: d.wall > w.wall,
				})),
			},
		],
		// The upkeep as the wall's rule has it; other plugins' cuts said after it (user 2026-11-05: "维持消耗：xxxxxx,xxxx,
		// xxxx, 双清观科技： -xx%").
		notes: isFree(costVar(total, resources))
			? []
			: [
					{
						text: cutTexts.length
							? text('Upkeep: {upkeep}/h · {cuts}', { upkeep: costVar(total, resources, { decimals: 1 }), cuts: cutTexts })
							: text('Upkeep: {upkeep}/h', { upkeep: costVar(total, resources, { decimals: 1 }) }),
					},
				],
	};
}
