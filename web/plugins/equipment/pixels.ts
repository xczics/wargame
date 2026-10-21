// Pixel sprites for the equipment screen's paper doll: indexed pixel maps (rows of palette letters) composed into RGBA
// in the browser. Pure: the tests run it. The art itself comes from a content plugin (`equipment` client service).

/** A pixel map at (x, y) on the doll's grid: each letter a palette role, "." transparent. */
export interface Sprite {
	x: number;
	y: number;
	rows: string[];
}

/** A crop on the grid: [x, y, w, h]. */
export type Box = [number, number, number, number];

/** A piece as the art draws it: over the figure, behind it (e.g. a cape), and the crop its icon shows. */
export interface PieceSprite {
	front: Sprite;
	back?: Sprite;
	icon: Box;
	/** The icon shows the figure under the piece (small accessories read better in place). */
	onFigure?: boolean;
}

/** A sprite with the colours of its letters ("#rrggbb"). */
export interface PixelLayer {
	sprite: Sprite;
	palette: Record<string, string>;
}

const rgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const toHex = (c: number[]) =>
	`#${c
		.map((v) =>
			Math.max(0, Math.min(255, Math.round(v)))
				.toString(16)
				.padStart(2, '0'),
		)
		.join('')}`;

/** A colour darkened (k < 0) or lightened (k > 0) by that share. */
export function shade(hex: string, k: number): string {
	return toHex(rgb(hex).map((v) => (k < 0 ? v * (1 + k) : v + (255 - v) * k)));
}

/** The layers drawn in order into an RGBA buffer of the box (w x h x 4); letters a palette lacks stay transparent. */
export function compose(layers: PixelLayer[], box: Box): Uint8ClampedArray {
	const [bx, by, w, h] = box;
	const out = new Uint8ClampedArray(w * h * 4);
	for (const { sprite, palette } of layers) {
		const colours = new Map(Object.entries(palette).map(([k, v]) => [k, rgb(v)]));
		sprite.rows.forEach((row, ry) => {
			const y = sprite.y + ry - by;
			if (y < 0 || y >= h) return;
			for (let rx = 0; rx < row.length; rx++) {
				const c = colours.get(row[rx]);
				const x = sprite.x + rx - bx;
				if (!c || x < 0 || x >= w) continue;
				const i = (y * w + x) * 4;
				out[i] = c[0];
				out[i + 1] = c[1];
				out[i + 2] = c[2];
				out[i + 3] = 255;
			}
		});
	}
	return out;
}

/** The largest whole scale at which a box fits in `size` CSS pixels (at least 1: pixels stay square and sharp). */
export function fitScale(box: Box, size: number): number {
	return Math.max(1, Math.floor(size / Math.max(box[2], box[3])));
}
