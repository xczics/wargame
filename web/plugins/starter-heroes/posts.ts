// The heroes' posts for the generic rows widget, assembled in the browser (AGENTS.md: the server sends data only) from
// who holds each post (`starter-heroes.posts`). Pure: the tests run it. The settlement's own on the city page
// (`starter-heroes.posts-city`), each building's on its entry (`starter-heroes.posts-entry`, `where`: the building type).
import type { HeroPost } from '../../../src/shared/api';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import { effectValue } from '../../../src/shared/starter-heroes';
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
