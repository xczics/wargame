// An icon's sprite as an image: an SVG of one path per colour (runs of pixels as rectangles, crisp edges), made once
// per art (a redrawn icon is a new image). Pure (a string, no DOM): the tests run it.

/** One icon's art: square rows of palette letters ("." transparent), the letters' colours. */
export interface IconArt {
	rows: string[];
	palette: Record<string, string>;
}

export interface IconImage {
	url: string;
	w: number;
	h: number;
}

const images = new WeakMap<IconArt, IconImage | null>();

/** The path of one colour's pixels: each horizontal run a rectangle. */
export function pixelPath(rows: readonly string[], letter: string): string {
	let d = '';
	rows.forEach((row, y) => {
		for (let x = 0; x < row.length;) {
			if (row[x] !== letter) {
				x++;
				continue;
			}
			const start = x;
			while (x < row.length && row[x] === letter) x++;
			d += `M${start} ${y}h${x - start}v1h${start - x}z`;
		}
	});
	return d;
}

export function iconImage(art: IconArt): IconImage | null {
	const cached = images.get(art);
	if (cached !== undefined) return cached;
	const w = Math.max(0, ...art.rows.map((r) => r.length));
	const h = art.rows.length;
	let image: IconImage | null = null;
	if (w && h) {
		const paths = Object.entries(art.palette)
			.map(([letter, colour]) => [colour, pixelPath(art.rows, letter)] as const)
			.filter(([, d]) => d)
			.map(([colour, d]) => `<path fill="${colour}" d="${d}"/>`)
			.join('');
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" shape-rendering="crispEdges">${paths}</svg>`;
		image = { url: `data:image/svg+xml,${encodeURIComponent(svg)}`, w, h };
	}
	images.set(art, image);
	return image;
}
