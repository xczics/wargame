// What the puzzles' commands did, in the player's data held in the browser (`game.patchView`; user 2026-11-20: "你告诉
// 前端成功了，前端不就能更新了吗？"): the Music House's board (`puzzles.mine`), the album (`puzzles.album`) and the Items
// page's puzzle cards (starter-puzzles' part of `items.extra`), as the server changed them. Which pieces have spares,
// and how many, only those cards say: without them held, the board is asked for again where it shows next. Pure: the
// tests run them.
import type { ItemsExtra, PuzzleAlbumEntry, PuzzleHolding, PuzzleProgress } from '../../../src/shared/api';

/** Where the Items page's puzzle cards come from (`items.addCards` of starter-puzzles). */
export const CARDS_SOURCE = 'starter-puzzles';

/** The player's puzzles as the Items page holds them (with each piece's spares), if it does. */
export const holdingsOf = (extra: ItemsExtra | undefined): PuzzleHolding[] | undefined => {
	if (!extra) return undefined;
	return (extra.find((x) => x.source === CARDS_SOURCE)?.data as PuzzleHolding[] | undefined) ?? [];
};

/** A holding after `take` of `piece` `n` times: its spares first, then the one in the picture. */
function taken(h: PuzzleHolding, piece: number, n: number): PuzzleHolding {
	const held = h.held.flatMap((x) => {
		if (x.piece !== piece) return [x];
		const spares = Math.max(0, x.spares - n);
		const count = n > x.spares ? spares : x.count - n;
		return count > 0 ? [{ ...x, count, spares }] : [];
	});
	const gone = n > (h.held.find((x) => x.piece === piece)?.spares ?? 0);
	return { ...h, held, pieces: gone ? h.pieces - 1 : h.pieces };
}

/** A holding after its claim: one of every piece goes (those with a spare keep their place in the picture). */
function claimedHolding(h: PuzzleHolding): PuzzleHolding {
	const held = h.held.filter((x) => x.spares > 0).map((x) => ({ ...x, count: x.spares, spares: x.spares - 1 }));
	return { ...h, held, pieces: held.length, claims: h.claims + 1 };
}

/** The board's progress from the holding (the same puzzle, after the change). */
const progressOf = (p: PuzzleProgress, h: PuzzleHolding): PuzzleProgress => ({
	...p,
	pieces: h.held.filter((x) => x.count > x.spares).map((x) => x.piece),
	spares: h.held.reduce((a, x) => a + x.spares, 0),
	claims: h.claims,
});

export interface PuzzlePatch {
	/** The holdings with the change, null when they are not held (then the board is made old). */
	holdings: PuzzleHolding[] | null;
	mine: (list: PuzzleProgress[]) => PuzzleProgress[] | null;
}

/** Pieces exchanged (`puzzles.exchange`). */
export function exchanged(holdings: PuzzleHolding[] | undefined, puzzle: string, piece: number, n: number): PuzzlePatch {
	const h = holdings?.find((x) => x.id === puzzle);
	if (!holdings || !h) return { holdings: null, mine: () => null };
	const after = taken(h, piece, n);
	return {
		holdings: holdings.map((x) => (x.id === puzzle ? after : x)),
		mine: (list) => list.map((p) => (p.id === puzzle ? progressOf(p, after) : p)),
	};
}

/** A puzzle claimed (`puzzles.claim`). Without the holdings, the board knows its claims only when it had no spares. */
export function claimedPuzzle(holdings: PuzzleHolding[] | undefined, puzzle: string): PuzzlePatch {
	const h = holdings?.find((x) => x.id === puzzle);
	if (!holdings || !h)
		return {
			holdings: null,
			mine: (list) =>
				list.some((p) => p.id === puzzle && p.spares > 0)
					? null
					: list.map((p) => (p.id === puzzle ? { ...p, pieces: [], claims: p.claims + 1 } : p)),
		};
	const after = claimedHolding(h);
	return {
		holdings: holdings.map((x) => (x.id === puzzle ? after : x)),
		mine: (list) => list.map((p) => (p.id === puzzle ? progressOf(p, after) : p)),
	};
}

/** The album with one more claim of `puzzle` (the first: mounted now). */
export const albumClaimed = (album: PuzzleAlbumEntry[], puzzle: string, now: number): PuzzleAlbumEntry[] =>
	album.some((e) => e.id === puzzle)
		? album.map((e) => (e.id === puzzle ? { ...e, claims: e.claims + 1 } : e))
		: [...album, { id: puzzle, claims: 1, firstAt: now }];

/** `items.extra` with the Items page's puzzle cards replaced. */
export const withHoldings = (extra: ItemsExtra, holdings: PuzzleHolding[]): ItemsExtra =>
	extra.map((x) => (x.source === CARDS_SOURCE ? { ...x, data: holdings } : x));
