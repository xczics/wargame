// The colours of the starter equipment's pixel art (part of the art, like the colours in an image file; the screen
// around it uses the CSS tokens). Gear letters: a/A/l the set's colour (base, shade, light), t/T/g the rarity's
// (trim, shade, gem); the rest are fixed (steel, wood, red, gold, straw, skin, white, silk, three rainbow colours).
import { shade } from '../../equipment/pixels';

const FIGURE_M: Record<string, string> = {
	o: '#2a1d18',
	s: '#f1c8a0',
	S: '#d49c74',
	h: '#2b2322',
	H: '#4f4240',
	e: '#1c1514',
	w: '#efe8d6',
	W: '#c8bda4',
	m: '#a3503f',
	p: '#4a3f37',
	P: '#2f2924',
	r: '#36597f',
	R: '#25405e',
	b: '#8b3a2b',
	B: '#64281e',
	y: '#d8a83c',
	Y: '#a07624',
	k: '#ede0cc',
	K: '#cdb9a0',
	f: '#2a2320',
	F: '#171211',
};

export const FIGURE_PALETTES: Record<'m' | 'f', Record<string, string>> = {
	m: FIGURE_M,
	f: {
		...FIGURE_M,
		p: '#e7a0a0',
		m: '#c83f4d',
		r: '#b84a68',
		R: '#8c3450',
		b: '#3f7290',
		B: '#2c546b',
		h: '#211b1d',
		H: '#463a40',
		f: '#8c3450',
		F: '#5e2235',
	},
};

/** Each set's colour (sets without one: grey). */
export const SET_COLOURS: Record<string, string> = {
	'azure-edge': '#4f80ab',
	'iron-guard': '#7c838c',
	wanderer: '#8a5c36',
	'mountain-warden': '#5f8052',
	'dragon-stride': '#2f7d6e',
	'phoenix-plume': '#c4462e',
	'heavens-plan': '#5b3f91',
	'plain-heart': '#dfe8d4',
	'drifting-cloud': '#8cc0e2',
	'rainbow-robe': '#e98fb6',
	'moon-palace': '#c6c0ec',
};

/** Each rarity's colour on the piece (trims and gems). */
export const RARITY_COLOURS: Record<string, string> = {
	white: '#c4c8cc',
	green: '#55b263',
	blue: '#4d8ae0',
	gold: '#e8b73c',
	purple: '#ad66e0',
};

const FIXED: Record<string, string> = {
	o: '#2a1d18',
	x: '#dfe5ea',
	X: '#97a3ae',
	n: '#7d5434',
	N: '#57391f',
	q: '#c9372b',
	Q: '#8f2219',
	y: '#e2b241',
	Y: '#a97b22',
	z: '#d9b66b',
	Z: '#a7843f',
	s: '#f1c8a0',
	S: '#d49c74',
	w: '#f4efe2',
	W: '#c9bfa8',
	k: '#f6f0f4',
	1: '#ef6f7a',
	2: '#f2c64e',
	3: '#62b6e6',
};

const cache = new Map<string, Record<string, string>>();
/** The palette of a piece of that set in that rarity (built once per pair). */
export function gearPalette(set: string | undefined, rarity: string): Record<string, string> {
	const key = `${set}|${rarity}`;
	let p = cache.get(key);
	if (!p) {
		const a = SET_COLOURS[set ?? ''] ?? '#8a8a8a';
		const t = RARITY_COLOURS[rarity] ?? RARITY_COLOURS.white;
		p = { ...FIXED, a, A: shade(a, -0.3), l: shade(a, 0.35), t, T: shade(t, -0.35), g: shade(t, 0.45) };
		cache.set(key, p);
	}
	return p;
}
