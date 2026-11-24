// What the heroes' commands did, told to the browser's own data at once (user 2026-11-20: "你告诉前端成功了，前端不就能
// 更新了吗？"): the heroes held here (`heroes.list`, every settlement's `heroes.state`, the candidates `heroes.offers`, the
// defence orders `heroes.defense`) changed the way the server changes them, so every page shows it without asking the
// server. Pure: the tests run them; ./index.ts applies them with `game.patchView`.
import type { HeroesState, HeroInfo, HeroOffers } from '../../../src/shared/api';
import { expToNextOf, type HeroGrowth } from '../../../src/shared/heroes';

/** A hero as `heroes.list` holds it. */
export type ListHero = Omit<HeroInfo, 'bonus'>;
/** What a command changed about a hero: fields of `heroes.list`. */
export type HeroChange = Partial<
	Pick<
		ListHero,
		| 'duty'
		| 'dutyTarget'
		| 'home'
		| 'attrs'
		| 'alloc'
		| 'freePoints'
		| 'level'
		| 'exp'
		| 'expToNext'
		| 'surname'
		| 'given'
		| 'talent'
		| 'talents'
	>
>;
type Card = HeroesState['heroes'][number];

export const changeInList = (list: ListHero[], id: string, change: HeroChange): ListHero[] =>
	list.some((h) => h.id === id) ? list.map((h) => (h.id === id ? { ...h, ...change } : h)) : list;

export const removeFromList = (list: ListHero[], id: string): ListHero[] =>
	list.some((h) => h.id === id) ? list.filter((h) => h.id !== id) : list;

/** A hero's card as the server makes it, from its row (what other plugins attached, `parts`, kept from the old card). */
function cardOf(state: HeroesState, h: ListHero, old?: Card): Card {
	return {
		id: h.id,
		surname: h.surname,
		given: h.given,
		gender: h.gender,
		level: h.level,
		exp: h.exp,
		expToNext: h.expToNext,
		talent: h.talent,
		talents: h.talents,
		freePoints: h.freePoints,
		attrs: h.attrs,
		duty: h.duty,
		// Named when it serves this settlement (a post); anywhere else the next sync names it.
		target: h.dutyTarget && h.dutyTarget === state.settlement.id ? state.settlement.name : h.dutyTarget ? (old?.target ?? null) : null,
		...(old?.parts ? { parts: old.parts } : {}),
	};
}

/**
 * One settlement's `heroes.state` after a hero changed (`hero`: the hero as it is now, its row): its card changed, gone
 * (attached elsewhere now) or come (attached here now; `order`: the heroes' order, as `heroes.list` has them).
 */
export function changeInState(state: HeroesState, hero: ListHero, order: string[], old?: Card): HeroesState {
	const here = state.heroes.find((c) => c.id === hero.id);
	if (hero.home !== state.settlement.id) return here ? { ...state, heroes: state.heroes.filter((c) => c.id !== hero.id) } : state;
	const card = cardOf(state, hero, here ?? old);
	if (here) return { ...state, heroes: state.heroes.map((c) => (c.id === hero.id ? card : c)) };
	const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
	return { ...state, heroes: [...state.heroes, card].sort((a, b) => rank(a.id) - rank(b.id)) };
}

/** As `changeInState`, without the hero's row here (`heroes.list` not fetched yet): its card alone, where it is. */
export function changeCard(state: HeroesState, id: string, change: HeroChange): HeroesState {
	if (!state.heroes.some((c) => c.id === id)) return state;
	const { dutyTarget, home: _h, alloc: _a, ...rest } = change;
	return {
		...state,
		heroes: state.heroes.map((c) =>
			c.id === id
				? {
						...c,
						...rest,
						...('dutyTarget' in change ? { target: dutyTarget && dutyTarget === state.settlement.id ? state.settlement.name : null } : {}),
					}
				: c,
		),
	};
}

/** Every `heroes.state` after a hero was let go: its card, and one fewer of the player's heroes. */
export const removeFromState = (state: HeroesState, id: string): HeroesState => ({
	...state,
	heroes: state.heroes.filter((c) => c.id !== id),
	total: Math.max(0, state.total - 1),
});

/** The points of `heroes.allocate` as sent: a `points` object, or the form's "points.<attribute>" fields. */
export function allocated(payload: Record<string, unknown>): Record<string, number> {
	const raw =
		payload.points && typeof payload.points === 'object'
			? (payload.points as Record<string, unknown>)
			: Object.fromEntries(Object.entries(payload).flatMap(([k, v]) => (k.startsWith('points.') ? [[k.slice(7), v]] : [])));
	const out: Record<string, number> = {};
	for (const [a, v] of Object.entries(raw)) {
		const n = Number(v);
		if (Number.isInteger(n) && n > 0) out[a] = n;
	}
	return out;
}

/** What spending free points changes about a hero, as the server does it (`heroes.allocate`). */
export function allocate(hero: ListHero, points: Record<string, number>): HeroChange {
	const attrs = { ...hero.attrs };
	const alloc = { ...hero.alloc };
	let total = 0;
	for (const [a, n] of Object.entries(points)) {
		attrs[a] = (attrs[a] ?? 0) + n;
		alloc[a] = (alloc[a] ?? 0) + n;
		total += n;
	}
	return { attrs, alloc, freePoints: hero.freePoints - total };
}

/**
 * What attaching a hero elsewhere changes (`heroes.setHome`): a post tied to the old home ends (`anywhere`: duties that
 * are not, e.g. leading an army, keep it; the command refuses those anyway).
 */
export function moveHome(hero: ListHero, settlement: string, anywhere: (duty: string) => boolean): HeroChange {
	const ends = hero.duty !== 'idle' && !anywhere(hero.duty) && hero.dutyTarget !== settlement;
	return { home: settlement, ...(ends ? { duty: 'idle', dutyTarget: null } : {}) };
}

/** A settlement's candidates after one was recruited: that slot taken, or the GM's placed one gone. */
export function recruited(offers: HeroOffers, p: { settlement: string; venue: string; slot?: number; gift?: string }): HeroOffers {
	if (offers.settlement !== p.settlement) return offers;
	return {
		...offers,
		venues: offers.venues.map((v) => {
			if (v.venue !== p.venue) return v;
			if (p.gift) return { ...v, gifts: v.gifts.filter((g) => g.id !== p.gift) };
			const slot = p.slot ?? -1;
			if (!v.candidates[slot]) return v;
			return { ...v, taken: [...v.taken, slot], candidates: v.candidates.map((c, i) => (i === slot ? null : c)) };
		}),
	};
}

/** The defence order of a settlement as saved (`heroes.setDefenseOrder`; none: strongest first). */
export const orderOf = (ids: string[]) => (ids.length ? [...new Set(ids)] : null);

/**
 * The hero a recruit made, from the candidate held in `heroes.offers` and the id the answer says, as the server makes it
 * (heroes.recruit): level 1, idle at home, its talents (or their total), what it was rolled with. Null: not held.
 */
export function recruit(
	offers: HeroOffers,
	p: { settlement: string; venue: string; slot?: number; gift?: string },
	id: string,
	growth: HeroGrowth,
): ListHero | null {
	const v = offers.venues.find((x) => x.venue === p.venue);
	const d = p.gift ? v?.gifts.find((g) => g.id === p.gift) : v?.candidates[Number(p.slot ?? -1)];
	if (!d) return null;
	return {
		id,
		surname: d.surname,
		given: d.given,
		gender: d.gender,
		origin: p.venue,
		attrs: { ...d.attrs },
		home: p.settlement,
		duty: 'idle',
		dutyTarget: null,
		level: 1,
		exp: 0,
		expToNext: expToNextOf(growth, 1),
		talent: d.talents ? Object.values(d.talents).reduce((a, b) => a + b, 0) : (d.talent ?? 3),
		talents: d.talents ?? null,
		freePoints: 0,
		alloc: {},
		extras: { ...(d.extras ?? {}) },
	};
}
