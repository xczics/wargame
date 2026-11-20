/**
 * For a command whose outcome only the server knows (when a job ends, what an order costs under every modifier): the
 * views it changed, when its answer did not bring them (sent from another page, e.g. by the assistant), are marked old
 * in the browser, so they are asked for again with the sync of the page that shows them next (user 2026-11-20). With
 * the answer bringing them, nothing to do. `game` is the browser's (web/core/game.ts).
 */
export interface AnsweredGame {
	afterCommand(
		type: string | ((type: string) => boolean),
		run: (type: string, payload: unknown) => void,
		options?: { answered?: boolean },
	): void;
	held(view: string): { at: number; value: unknown }[];
	markStale(view: string): void;
}

export function staleUnlessAnswered(game: AnsweredGame, type: string | ((type: string) => boolean), views: readonly string[]) {
	let sent = 0;
	game.afterCommand(type, () => void (sent = Date.now()));
	game.afterCommand(
		type,
		() => {
			for (const v of views) if (!game.held(v).some((h) => h.at >= sent)) game.markStale(v);
		},
		{ answered: true },
	);
}

/**
 * Change a view's data held in the browser by `change`, all but what came in the command's answer just now (at or after
 * `since`): for what a command did that its answer, where it brought the view, has already.
 */
export function patchHeldBefore<T>(
	game: Pick<AnsweredGame, 'held'> & { patchView<V>(view: string, change: (value: V) => V): void },
	view: string,
	since: number,
	change: (value: T) => T,
) {
	const fresh = new Set(
		game
			.held(view)
			.filter((h) => h.at >= since)
			.map((h) => h.value),
	);
	game.patchView<T>(view, (v) => (fresh.has(v) ? v : change(v)));
}
