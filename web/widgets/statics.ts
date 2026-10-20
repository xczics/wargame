// A player's view over a static view (`base`): the static part fetched once by version and kept (game.static),
// merged with the player's part by the shared rules (src/shared/statics.ts).
import { computed, type ComputedRef } from 'vue';
import { mergeCards, mergeRows, mergeTree, resolveCards } from '../../src/shared/statics';
import type { CardsData, RowsData, TreeData } from '../../src/shared/ui';
import type { Game } from '../core/game';

function useMerged<T extends { base?: string }>(
	game: Game,
	view: () => string,
	merge: (base: T, d: T) => T,
	alone: (d: T) => T = (d) => d,
): ComputedRef<T | null> {
	return computed(() => {
		const d = (game.view(view() as never) ?? null) as T | null;
		if (!d) return d;
		if (!d.base) return alone(d);
		const base = game.static<T>(d.base);
		return base ? merge(base, d) : null;
	});
}
/** `ui.cards` / `ui.filters`. */
export const useCards = (game: Game, view: () => string) =>
	useMerged<CardsData>(
		game,
		view,
		(base, d) => mergeCards(base, d, (key) => game.counter(key)),
		// Without a static base (a view assembled in the browser): its buttons still go by the counters.
		(d) => resolveCards(d, (key) => game.counter(key)),
	);
/** `ui.rows` (its rows' `needs` also go by the client's own counters, e.g. resources counted on). */
export const useRows = (game: Game, view: () => string) =>
	useMerged<RowsData>(game, view, (base, d) => mergeRows(base, d, (key) => game.counter(key)));
/** `ui.tree`. */
export const useTree = (game: Game, view: () => string) => useMerged<TreeData>(game, view, mergeTree);
