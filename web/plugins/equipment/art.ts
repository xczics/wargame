// What the paper doll needs from an art pack (a content plugin provides it through the `equipment` client service: the
// equipment system knows no slot, set or figure of its own). Pure helpers for where slot frames go; the tests run them.
import type { Box, PixelLayer } from './pixels';

export interface DollArt {
	/** The grid every sprite is drawn on: [w, h]. */
	size: [number, number];
	/** The hero's figure (transparent around it). */
	figure(gender: 'm' | 'f'): PixelLayer;
	/** A worn or stored piece as drawn on that figure, coloured for its set and rarity; null: no art for it. */
	piece(p: { slot: string; set?: string; rarity: string }, gender: 'm' | 'f'): DollPieceArt | null;
	/** Which side of the figure a regular slot's frame goes (slots it does not place: shared out after). */
	side(slot: string): 'left' | 'right' | undefined;
}

export interface DollPieceArt {
	front: PixelLayer;
	back?: PixelLayer;
	icon: Box;
	/** The icon shows this figure under the piece (small accessories read better in place). */
	iconFigure?: 'm' | 'f';
	/** Drawing order among the pieces (higher: over the others). */
	z: number;
}

/** The regular slots split into the frames left and right of the figure, keeping their order. */
export function slotColumns<T extends { id: string }>(slots: T[], side: (id: string) => 'left' | 'right' | undefined) {
	const left: T[] = [];
	const right: T[] = [];
	const loose: T[] = [];
	for (const s of slots) (side(s.id) === 'left' ? left : side(s.id) === 'right' ? right : loose).push(s);
	for (const s of loose) (left.length <= right.length ? left : right).push(s);
	return { left, right };
}

/** The layers of a figure wearing pieces, in drawing order: what goes behind, the figure, then the pieces. */
export function dollLayers(figure: PixelLayer, pieces: (DollPieceArt | null)[]): PixelLayer[] {
	const worn = pieces.filter((p): p is DollPieceArt => !!p).sort((a, b) => a.z - b.z);
	return [...worn.flatMap((p) => (p.back ? [p.back] : [])), figure, ...worn.map((p) => p.front)];
}

/** The layers of a piece's icon: its crop shows what is behind it, the figure under it where the art says so, the piece. */
export const iconLayers = (art: DollArt, pa: DollPieceArt): PixelLayer[] => [
	...(pa.back ? [pa.back] : []),
	...(pa.iconFigure ? [art.figure(pa.iconFigure)] : []),
	pa.front,
];

/** A sprite's own box. */
