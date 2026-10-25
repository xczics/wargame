// A player's view over a static view (`base`): the static part fetched once by version and kept (game.static),
// merged with the player's part by the shared rules (src/shared/statics.ts).
import { computed, type ComputedRef } from 'vue';
import { counterUses, mergeCards, mergeRows, mergeTree, resolveCards } from '../../src/shared/statics';
import type { CardsData, RowsData, TreeData } from '../../src/shared/ui';
import type { Game } from '../core/game';

function useMerged<T extends { base?: string }>(
	game: Game,
	view: () => string,
	merge: (base: T, d: T, counter: (key: string) => number | undefined) => T,
	alone: (d: T, counter: (key: string) => number | undefined) => T = (d) => d,
): ComputedRef<T | null> {
	// The view and its static base: what changes with a sync.
	const source = computed(() => {
		const d = (game.view(view() as never) ?? null) as T | null;
		return d?.base ? { d, base: game.static<T>(d.base) ?? null } : { d, base: null };
	});
	// The counters they compare or show: walked once a sync, not every tick.
	const uses = computed(() => counterUses(source.value.d, source.value.base));
	// What the merge depends on of the counters: each comparison's outcome and the shown values. The clock the resources
	// count on with ticks ten times a second; this string changes only when a price turns affordable or short, and an
	// unchanged computed value does not trigger the merge below (2026-10-25: every card with a price re-merged 10x a second).
	let seen = new Map<string, number>();
	const signature = computed(() => {
		const now = new Map<string, number>();
		const read = (k: string) => (now.has(k) ? now.get(k)! : (now.set(k, game.counter(k) ?? 0), now.get(k)!));
		const out = [
			...uses.value.compare.map(([k, amount]) => (read(k) >= amount ? '1' : '0')),
			...uses.value.values.map((k) => String(read(k))),
		].join(',');
		seen = now;
		return out;
	});
	// A counter the walk missed is read as before (always right, just not spared).
	const counter = (k: string) => (seen.has(k) ? seen.get(k) : game.counter(k));
	return computed(() => {
		void signature.value;
		const { d, base } = source.value;
		if (!d) return d;
		if (!d.base) return alone(d, counter);
		return base ? merge(base, d, counter) : null;
	});
}
/** `ui.cards` / `ui.filters`. */
export const useCards = (game: Game, view: () => string) =>
	useMerged<CardsData>(
		game,
		view,
		(base, d, counter) => mergeCards(base, d, counter),
		// Without a static base (a view assembled in the browser): its buttons still go by the counters.
		(d, counter) => resolveCards(d, counter),
	);
/** `ui.rows` (its rows' `needs` also go by the client's own counters, e.g. resources counted on). */
export const useRows = (game: Game, view: () => string) =>
	useMerged<RowsData>(game, view, (base, d, counter) => mergeRows(base, d, counter));
/** `ui.tree`. */
export const useTree = (game: Game, view: () => string) => useMerged<TreeData>(game, view, mergeTree);
