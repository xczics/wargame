// The heroes' posts for the generic rows widget, assembled in the browser (AGENTS.md: the server sends data only) from
// who holds each post (`starter-heroes.posts`). Pure: the tests run it. The settlement's own on the city page
// (`starter-heroes.posts-city`), each building's on its entry (`starter-heroes.posts-entry`, `where`: the building type).
import type { HeroInfo, HeroPost } from '../../../src/shared/api';
import { nameKey } from '../../../src/shared/heroes';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import { dutyEffects, effectValue, type HeroEffectsStatic } from '../../../src/shared/starter-heroes';
import type { RowsData, UiRow } from '../../../src/shared/ui';

// The starter-heroes plugin's own words (its i18n keys): the rows read as they did when the server built them.
const text = uiTexts('starter-heroes');

const postRow = (p: HeroPost): UiRow => ({
	id: p.post,
	title: keyText(p.name),
	...(p.limit ? { badge: text('{n} / {max}', { n: p.heroes.length, max: p.limit }) } : {}),
	lines: p.heroes.length
		? [
				{ text: text('{list}', { list: p.names.map((hero) => text('{hero}', { hero })) }) },
				{
					text: text('{list}', {
						list: p.effects.map((e) => text('{effect} {value}', { effect: text(`effect:${e.effect}`), value: effectValue(e) })),
					}),
					tone: 'muted',
				},
			]
		: [{ text: text('Nobody.'), tone: 'muted' }],
	...(p.heroes.length ? {} : { actions: [{ page: 'heroes', label: text('Assign heroes') }] }),
});

export function postRows(posts: HeroPost[] | null | undefined, onEntry: boolean): RowsData | null | undefined {
	if (posts === undefined) return undefined;
	const here = (posts ?? []).filter((p) => !!p.building === onEntry);
	if (!here.length) return null;
	// One section per row on entries (each row's building), one for the city page.
	return onEntry
		? { title: text('Heroes here'), sections: here.map((p) => ({ where: p.building, rows: [postRow(p)] })) }
		: { title: text('Heroes of this settlement'), sections: [{ rows: here.map(postRow) }] };
}

type Hero = Omit<HeroInfo, 'bonus'>;
/** What the browser holds besides the server's posts, to keep them as the heroes are now (each may be missing). */
export interface PostsHeld {
	/** The settlement the posts are of. */
	settlement: string | undefined;
	heroes: Hero[] | undefined;
	/** Its saved defence order (null: strongest first); undefined: not held. */
	order: string[] | null | undefined;
	effects: HeroEffectsStatic | undefined;
	/** Whether a duty keeps a hero in town (it defends); undefined: not known (the server counts it in). */
	inTown(duty: string): boolean | undefined;
	/** A hero's attributes with every bonus the browser adds ("heroes.attributes": the gear). */
	attrs(hero: Hero): Record<string, number>;
}

/**
 * The posts as the heroes held here are now (user 2026-11-20: "前端充分利用大对象的数据"): who holds each (their duty and
 * the settlement they serve, from `heroes.list`, which the commands keep current), who would defend (the order saved,
 * else the strongest first, as the server ranks them) and what they add up to (the same `dutyEffects` as the server, on
 * their attributes with the gear). What the browser does not hold stays as the server sent it. Pure: the tests run it.
 */
export function livePosts(posts: HeroPost[] | null | undefined, held: PostsHeld): HeroPost[] | null | undefined {
	const { settlement, heroes, effects } = held;
	if (!posts || !settlement || !heroes) return posts;
	const defendAttrs = [...new Set((effects?.rows ?? []).filter((r) => r.duty === 'defend').map((r) => r.attribute))];
	const score = (h: Hero) => defendAttrs.reduce((sum, a) => sum + (h.attrs[a] ?? 0), 0);
	const byId = new Map(heroes.map((h) => [h.id, h]));
	return posts.map((p) => {
		let members: Hero[] | undefined;
		if (p.post !== 'defend') members = heroes.filter((h) => h.duty === p.post && h.dutyTarget === settlement);
		else if (held.order !== undefined && effects) {
			const attached = heroes.filter((h) => h.home === settlement);
			const ranked = held.order
				? held.order.map((id) => attached.find((h) => h.id === id)).filter((h): h is Hero => !!h)
				: [...attached].sort((a, b) => score(b) - score(a));
			members = ranked.filter((h) => held.inTown(h.duty) !== false).slice(0, p.limit);
		} else {
			const known = p.heroes.map((id) => byId.get(id));
			members = known.every((h) => !!h) ? (known as Hero[]) : undefined;
		}
		if (!members) return p;
		return {
			...p,
			heroes: members.map((h) => h.id),
			names: members.map(nameKey),
			effects: effects
				? dutyEffects(
						effects.rows,
						effects.rules,
						p.post,
						members.map((h) => ({ attrs: held.attrs(h), level: h.level })),
					)
				: p.effects,
		};
	});
}
