// The Heroes page's displays, assembled in the browser (AGENTS.md: the server sends data only) from the heroes of the
// selected settlement (`heroes.state`) and the venues' candidates (`heroes.offers`). Pure: the tests run them.
import { costNeeds } from '../../../src/shared/format';
import type { HeroCardPart, HeroesState, HeroOffers, Meta } from '../../../src/shared/api';
import type { ClientViewGet } from '../../../src/shared/client-views';
import { heroAttributes, nameKey } from '../../../src/shared/heroes';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import { breakdownTexts } from '../../../src/shared/stats';
import type { CardsData, RowsData, UiCard, UiLine } from '../../../src/shared/ui';

// The heroes plugin's own words (its i18n keys): the cards read as they did when the server built them.
const text = uiTexts('heroes');

/**
 * The heroes attached here (generic `ui.cards`), each with its level, duty, experience, attributes with what other
 * client plugins add to them ("heroes.attributes", e.g. equipment) and their lines ("heroes.card": what it gives in each
 * role, its adventure numbers, worked out here from the attributes, the statics and what their server plugins attached);
 * "Manage" opens its forms (placement "hero": duty, attachment, free points, dismissal). Attribute and duty names come
 * from the meta.
 */
export function heroCards(
	state: HeroesState | null | undefined,
	meta: Meta['heroes'],
	parts: ReadonlyMap<string, HeroCardPart>,
	get: ClientViewGet,
): CardsData | null | undefined {
	if (!state) return state;
	const attributes = meta?.attributes ?? [];
	const duties = new Map((meta?.duties ?? []).map((d) => [d.id, d.name]));
	const cards: UiCard[] = state.heroes.map((h) => {
		const duty = keyText(duties.get(h.duty) ?? h.duty);
		const attrs = heroAttributes(h, get);
		const hero = { id: h.id, level: h.level, gender: h.gender, attrs };
		const more = [...parts].flatMap(([id, part]) => part(h.parts?.[id], hero, get));
		const lines: UiLine[] = [
			{
				text: h.target ? text('Lv {0} · {1} · {2}', { 0: h.level, 1: duty, 2: h.target }) : text('Lv {0} · {1}', { 0: h.level, 1: duty }),
			},
			{
				text: h.expToNext
					? text('Experience {exp} / {need} · Talent {n}', { exp: h.exp, need: h.expToNext, n: h.talent })
					: text('Highest level · Talent {n}', { n: h.talent }),
				tone: 'muted',
			},
			{
				text: text(''),
				parts: attributes.map((a) => {
					const add = (attrs[a.id] ?? 0) - (h.attrs[a.id] ?? 0);
					return {
						text: text('{0} {1}{2}{3}', {
							0: keyText(a.name),
							1: h.attrs[a.id] ?? 0,
							2: add ? ` +${Math.round(add)}` : '',
							3: h.talents?.[a.id] ? ` ▲${h.talents[a.id]}` : '',
						}),
					};
				}),
			},
			...(h.freePoints ? [{ text: text('{n} free points', { n: h.freePoints }), tone: 'info' as const }] : []),
			...more.map((l) => ({ text: l, tone: 'muted' as const })),
		];
		return {
			id: h.id,
			icon: h.gender === 'f' ? '👸' : '🧔',
			title: keyText(nameKey(h)),
			lines,
			detail: { label: text('Manage'), form: { placement: 'hero', context: { hero: h.id } } },
		};
	});
	// The limit counts every hero, wherever attached; at the limit no more can be recruited.
	return {
		header: {
			title: text('Heroes of {name}', { name: state.settlement.name }),
			lines: [
				{
					text: text('{0} here · heroes {1} / {2}', { 0: state.heroes.length, 1: state.total, 2: state.cap.value }),
					tone: state.total >= state.cap.value ? 'warn' : 'muted',
					hint: breakdownTexts(state.cap),
				},
			],
		},
		cards,
		empty: state.total
			? text('No heroes are attached to this settlement.')
			: text('No heroes yet. Recruit them at a tavern, academy or music house.'),
	};
}

/** The defence order for the generic rows widget: each ↑ / ↓ saves the order with that swap at once. */
export function defenseRows(state: HeroesState | null | undefined): RowsData | null | undefined {
	if (!state) return state;
	const s = state.settlement;
	const saved = state.order;
	const ids = state.heroes.map((h) => h.id);
	const order = [...(saved ?? []).filter((id) => ids.includes(id)), ...ids.filter((id) => !(saved ?? []).includes(id))];
	const byId = new Map(state.heroes.map((h) => [h.id, h]));
	const swapped = (i: number, j: number) => {
		const next = [...order];
		[next[i], next[j]] = [next[j], next[i]];
		return { command: 'heroes.setDefenseOrder', payload: { settlement: s.id, heroes: next } };
	};
	const edge = text('—');
	return {
		title: text('Defence order'),
		sections: [
			{
				rows: [
					...order.map((id, i) => ({
						id,
						title: text('{n}. {hero}', { n: i + 1, hero: nameKey(byId.get(id)!) }),
						actions: [
							{ ...swapped(i, i - 1), label: text('↑'), ...(i === 0 ? { blocked: edge } : {}) },
							{ ...swapped(i, i + 1), label: text('↓'), ...(i === order.length - 1 ? { blocked: edge } : {}) },
						],
					})),
					...(saved
						? [
								{
									id: 'reset',
									title: text('Strongest first'),
									actions: [{ command: 'heroes.setDefenseOrder', payload: { settlement: s.id, heroes: [] }, label: text('Reset') }],
								},
							]
						: []),
				],
				lines: state.heroes.length
					? saved
						? []
						: [{ text: text('Strongest first (not set).'), tone: 'muted' as const }]
					: [{ text: text('No heroes attached here.'), tone: 'muted' as const }],
			},
		],
		notes: [{ text: text('The first heroes here that are in town defend this settlement; the rest are substitutes.'), tone: 'muted' }],
	};
}

/**
 * The candidates as generic cards: a section per venue (when it renews), a card per slot; on a venue's building entry
 * only its own ("building:<type>").
 */
export function candidateCards(offers: HeroOffers | null | undefined): CardsData | undefined {
	if (offers === undefined) return undefined;
	const groups: NonNullable<CardsData['groups']> = [];
	const cards: UiCard[] = [];
	for (const v of offers?.venues ?? []) {
		const s = offers!.settlement;
		groups.push({
			id: v.venue,
			label: keyText(v.name),
			lines: [{ text: text('New candidates in'), tone: 'muted', endsAt: v.refreshesAt }],
		});
		const where = ['page:heroes', `building:${v.building}`];
		const list = [
			...v.candidates.map((c, slot) => ({ c, slot, gift: undefined as string | undefined })),
			...v.gifts.map((g) => ({ c: g, slot: -1, gift: g.id })),
		];
		for (const [i, { c, slot, gift }] of list.entries()) {
			const id = `${v.venue}/${gift ?? i}`;
			if (!c) {
				cards.push({ id, group: v.venue, where, title: text(v.taken.includes(i) ? 'Recruited' : 'Nobody this time') });
				continue;
			}
			cards.push({
				id,
				group: v.venue,
				where,
				icon: c.gender === 'f' ? '👸' : '🧔',
				title: keyText(nameKey(c)),
				lines: [
					{
						text: text(''),
						parts: offers!.attributes.map((a) => ({
							text: text(c.talents?.[a.id] ? '{0} {1} ▲{2}' : '{0} {1}', {
								0: keyText(a.name),
								1: c.attrs[a.id] ?? 0,
								2: c.talents?.[a.id] ?? 0,
							}),
						})),
					},
				],
				actions: [
					{
						command: 'heroes.recruit',
						payload: gift ? { settlement: s, venue: v.venue, gift } : { settlement: s, venue: v.venue, slot },
						label: text('Recruit'),
						// The price counted against the settlement's resources by the cards (src/shared/statics.ts).
						parts: costNeeds(v.cost, offers!.icons),
						short: text('Not enough resources'),
					},
				],
			});
		}
	}
	return { groups, cards, empty: text('No recruiting buildings here.') };
}
