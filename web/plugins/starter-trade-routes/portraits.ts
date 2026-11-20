// Portraits for the starter trade routes' people (user 2026-11-16: "立绘尝试（像素或 SVG）"): 32x32 pixel busts, each
// put together from parts (a head, hair or headgear, a beard, a mask or a patch, a robe) in its own colours, so that the
// same few parts make many faces. The Thousand Li's bookkeeper, its guard captain Lu Jiu and its captain Shen Du come
// back across the chapters; the bosses each have their own. Pure: the tests run it.

import { seededRandom } from '../../../src/shared/random';
import type { PortraitArt } from '../trade-routes/plan';

type Hat = 'none' | 'guan' | 'turban' | 'helmet' | 'hood' | 'bun' | 'crown' | 'veil';
interface Spec {
	hat: Hat;
	hair?: 'short' | 'long' | 'none';
	beard?: 'long' | 'goatee' | 'full';
	mask?: boolean;
	patch?: boolean;
	/** No face at all: fog where it should be. */
	faceless?: boolean;
	old?: boolean;
	/** k skin, h hair, a headgear, A its trim, r robe, c collar, b beard, g mask, e eyes. */
	colours: Partial<Record<'k' | 'h' | 'a' | 'A' | 'r' | 'c' | 'b' | 'g' | 'e', string>>;
}

const SIZE = 32;
const OUTLINE = '#2a1d12';
const shade = (hex: string, k: number) =>
	`#${[1, 3, 5]
		.map((i) =>
			Math.max(0, Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 + k))))
				.toString(16)
				.padStart(2, '0'),
		)
		.join('')}`;

function draw(spec: Spec): PortraitArt {
	const g: string[][] = Array.from({ length: SIZE }, () => Array(SIZE).fill('.'));
	const set = (x: number, y: number, c: string) => {
		if (x >= 0 && y >= 0 && x < SIZE && y < SIZE) g[y][x] = c;
	};
	const ellipse = (cx: number, cy: number, rx: number, ry: number, c: string, keep?: (x: number, y: number) => boolean) => {
		for (let y = 0; y < SIZE; y++)
			for (let x = 0; x < SIZE; x++)
				if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1 && (!keep || keep(x, y))) set(x, y, c);
	};
	const rect = (x0: number, y0: number, x1: number, y1: number, c: string) => {
		for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, c);
	};
	const inHead = (x: number, y: number) => ((x + 0.5 - 16) / 6.5) ** 2 + ((y + 0.5 - 14) / 8) ** 2 <= 1;

	// Behind: a hood, long hair.
	if (spec.hat === 'hood') ellipse(16, 13, 10, 11.5, 'a');
	if (spec.hair === 'long' || spec.hat === 'veil') {
		rect(8, 10, 10, 27, spec.hat === 'veil' ? 'a' : 'h');
		rect(22, 10, 24, 27, spec.hat === 'veil' ? 'a' : 'h');
	}
	// The robe, its shade and collar; the neck.
	for (let y = 24; y < SIZE; y++) {
		const w = Math.round(7 + (y - 24) * 1.3);
		for (let x = 16 - w; x <= 15 + w; x++) set(x, y, x > 16 + w / 3 ? 'R' : 'r');
		if (y <= 29) {
			set(16 - (y - 23), y, 'c');
			set(15 + (y - 23), y, 'c');
		}
	}
	rect(14, 21, 17, 24, 'K');
	// The head.
	ellipse(16, 14, 6.5, 8, spec.faceless ? 'f' : 'k');
	if (!spec.faceless) for (let y = 6; y < 22; y++) for (let x = 19; x < 23; x++) if (inHead(x, y)) set(x, y, 'K');
	// Hair.
	if (spec.hair !== 'none' && !['hood', 'helmet', 'veil'].includes(spec.hat)) {
		for (let y = 5; y < 11; y++) for (let x = 8; x < 24; x++) if (inHead(x, y)) set(x, y, 'h');
		rect(9, 10, 10, 15, 'h');
		rect(22, 10, 23, 15, 'h');
	}
	if (spec.hat === 'bun') ellipse(16, 4.5, 3, 2.5, 'h');
	// The face.
	if (!spec.faceless) {
		const eye = spec.mask ? 'o' : 'e';
		for (const x of [12, 13, 18, 19]) set(x, 14, eye);
		for (const x of [12, 13, 18, 19]) set(x, 12, spec.old ? 'b' : 'h');
		set(16, 16, 'K');
		for (const x of [15, 16]) set(x, 19, 'm');
		if (spec.old) {
			set(11, 16, 'K');
			set(20, 16, 'K');
		}
	}
	if (spec.beard === 'long')
		for (let y = 18; y < 28; y++) for (let x = 13 + Math.floor((y - 18) / 4); x <= 18 - Math.floor((y - 18) / 4); x++) set(x, y, 'b');
	if (spec.beard === 'goatee') rect(15, 20, 16, 23, 'b');
	if (spec.beard === 'full') {
		for (let y = 17; y < 23; y++) for (let x = 9; x < 23; x++) if (inHead(x, y)) set(x, y, 'b');
		rect(13, 22, 18, 24, 'b');
	}
	if (spec.beard) for (const x of [15, 16]) set(x, 19, 'm');
	if (spec.mask) {
		for (let y = 8; y < 19; y++) for (let x = 9; x < 23; x++) if (inHead(x, y)) set(x, y, x > 18 ? 'G' : 'g');
		for (const x of [12, 13, 18, 19]) set(x, 14, 'o');
	}
	if (spec.patch) {
		for (let i = 0; i < 13; i++) set(10 + i, 12 - Math.floor(i / 5), 'o');
		rect(12, 13, 14, 15, 'o');
	}
	// Headgear.
	if (spec.hat === 'guan') {
		// A black gauze cap: a tall crown, a rounded back, and the thin wings standing out at the sides.
		rect(11, 4, 20, 8, 'a');
		ellipse(16, 4, 4.5, 3.5, 'a', (_x, y) => y < 5);
		rect(11, 8, 20, 8, 'A');
		rect(3, 5, 10, 5, 'a');
		rect(21, 5, 28, 5, 'a');
		set(3, 4, 'a');
		set(28, 4, 'a');
	}
	if (spec.hat === 'turban') {
		ellipse(16, 7.5, 8.5, 4.5, 'a');
		for (const x of [10, 13, 16, 19, 22]) set(x, 7, 'A');
		set(16, 5, 'A');
		set(16, 6, 'A');
	}
	if (spec.hat === 'helmet') {
		ellipse(16, 10, 8, 7.5, 'a', (_x, y) => y < 10);
		rect(8, 10, 23, 10, 'A');
		rect(8, 11, 9, 18, 'a');
		rect(22, 11, 23, 18, 'a');
		rect(16, 0, 16, 3, 'A');
	}
	if (spec.hat === 'crown') {
		rect(10, 3, 21, 7, 'A');
		for (const x of [10, 13, 16, 18, 21]) rect(x, 1, x, 2, 'A');
		set(16, 5, 'r');
	}
	if (spec.hat === 'veil') ellipse(16, 8, 8, 5, 'a', (_x, y) => y < 9);
	// The outline: every empty pixel next to a drawn one.
	const out = g.map((row) => [...row]);
	for (let y = 0; y < SIZE; y++)
		for (let x = 0; x < SIZE; x++)
			if (
				g[y][x] === '.' &&
				[
					[1, 0],
					[-1, 0],
					[0, 1],
					[0, -1],
				].some(([dx, dy]) => (g[y + dy]?.[x + dx] ?? '.') !== '.' && g[y + dy]?.[x + dx] !== 'o')
			)
				out[y][x] = 'o';
	const c = spec.colours;
	const skin = c.k ?? '#e2b48a';
	const robe = c.r ?? '#7a5232';
	const mask = c.g ?? '#d8a838';
	return {
		rows: out.map((r) => r.join('')),
		palette: {
			o: OUTLINE,
			k: skin,
			K: shade(skin, -0.15),
			e: c.e ?? '#1d140c',
			m: shade(skin, -0.35),
			h: c.h ?? '#2b2018',
			a: c.a ?? '#2b2b2b',
			A: c.A ?? '#c9a24a',
			r: robe,
			R: shade(robe, -0.25),
			c: c.c ?? '#e8dcc0',
			b: c.b ?? c.h ?? '#2b2018',
			g: mask,
			G: shade(mask, -0.25),
			f: '#b9b4a8',
		},
	};
}

/** The people of the starter routes, by portrait id (nodes.csv's `portrait` column). */
export const PORTRAITS: Record<string, PortraitArt> = {
	// The Thousand Li: its bookkeeper (who became the King of the Oasis), its guard captain, its captain.
	bookkeeper: draw({ hat: 'guan', beard: 'goatee', colours: { r: '#2f4a6b', a: '#1f1f24', A: '#8a6a2a' } }),
	'oasis-king': draw({ hat: 'crown', beard: 'goatee', colours: { r: '#6b2f6b', A: '#d8b040', c: '#e6c25a' } }),
	'lu-jiu': draw({ hat: 'helmet', beard: 'full', colours: { r: '#5a3b24', a: '#6b6f78', A: '#b9bec6', b: '#2a1d12' } }),
	'mountain-god': draw({
		hat: 'helmet',
		beard: 'full',
		colours: { k: '#d8dde2', r: '#e8ecef', a: '#9aa6b2', A: '#ffffff', b: '#f4f6f8', c: '#9aa6b2' },
	}),
	'shen-du': draw({ hat: 'bun', hair: 'long', colours: { r: '#1f5a5a', h: '#1c1612', c: '#d8c8a0' } }),
	// The silk road.
	postmaster: draw({ hat: 'none', beard: 'long', old: true, colours: { h: '#d0ccc4', b: '#e6e2da', r: '#6b6252' } }),
	hawk: draw({ hat: 'hood', patch: true, beard: 'goatee', colours: { a: '#7a5a3a', r: '#7a5a3a', c: '#a8865a', k: '#c8925e' } }),
	'bandit-king': draw({ hat: 'turban', beard: 'full', colours: { a: '#e8e0cc', A: '#b8321f', r: '#8a2a1e', k: '#c08458' } }),
	'gold-mask': draw({ hat: 'hood', mask: true, colours: { a: '#3a2a4a', r: '#3a2a4a', c: '#d8a838' } }),
	// The tea-horse road.
	'tax-clerk': draw({ hat: 'guan', colours: { r: '#3a5a3a', a: '#1f1f24', A: '#6b8a4a' } }),
	'fog-master': draw({ hat: 'hood', faceless: true, colours: { a: '#8a9490', r: '#8a9490', c: '#c8d0cc' } }),
	'gu-woman': draw({ hat: 'veil', old: true, colours: { a: '#2a2a3a', A: '#c0c0c8', r: '#3a2a5a', c: '#c0c0c8', k: '#c89a72' } }),
	'gu-king': draw({ hat: 'turban', beard: 'goatee', colours: { a: '#2a2a3a', A: '#d8d0b0', r: '#4a2a5a', k: '#b8845a' } }),
	// The sea route.
	'harbour-official': draw({ hat: 'guan', beard: 'goatee', colours: { r: '#8a2a2a', a: '#1f1f24', A: '#c9a24a' } }),
	'dragon-king': draw({ hat: 'crown', beard: 'long', colours: { r: '#1e4a7a', A: '#d8b040', b: '#3a3028', c: '#d8b040' } }),
	admiral: draw({ hat: 'guan', beard: 'full', colours: { r: '#a8321f', a: '#1f1f24', A: '#d8b040', b: '#3a3028' } }),
	'ruins-lord': draw({ hat: 'hood', faceless: true, colours: { a: '#1e2a3a', r: '#1e2a3a', c: '#c9a24a' } }),
};

// Everyone else's face (user 2026-11-20: "自己的英雄没有头像立绘"): the player's heroes by their id, enemy generals by
// where they stand, drawn from the same parts in colours picked by a seed (the same seed, the same face).
const SKINS = ['#e2b48a', '#d9a274', '#c8925e', '#b8845a', '#efc49c', '#a8744e'];
const HAIRS = ['#2b2018', '#1c1612', '#4a3020', '#6b4a2a', '#3a3a3a'];
const ROBES = ['#2f4a6b', '#6b2f2f', '#3a5a3a', '#5a3b24', '#4a2a5a', '#1f5a5a', '#7a5232', '#8a6a2a', '#3a3a4a', '#6b6252'];
const TRIMS = ['#c9a24a', '#e8dcc0', '#b8321f', '#d8b040', '#9aa6b2', '#6b8a4a'];
const HATS_M: Hat[] = ['none', 'guan', 'turban', 'helmet', 'hood', 'bun', 'helmet', 'none'];
const HATS_F: Hat[] = ['bun', 'veil', 'hood', 'none', 'bun'];
const BEARDS = [undefined, undefined, 'long', 'goatee', 'full', 'goatee'] as const;
const faces = new Map<string, PortraitArt>();
export function face(seed: string, gender: 'm' | 'f' = 'm'): PortraitArt {
	const key = `${gender}:${seed}`;
	let art = faces.get(key);
	if (!art) {
		const random = seededRandom(`face:${key}`);
		const pick = <T>(list: readonly T[]) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
		const hat = pick(gender === 'f' ? HATS_F : HATS_M);
		const hair = pick(HAIRS);
		const old = random() < 0.15;
		art = draw({
			hat,
			hair: gender === 'f' ? 'long' : hat === 'none' && random() < 0.5 ? 'long' : 'short',
			...(gender === 'm' ? { beard: pick(BEARDS) } : {}),
			...(gender === 'm' && random() < 0.06 ? { patch: true } : {}),
			old,
			colours: {
				k: pick(SKINS),
				h: old ? '#c8c4bc' : hair,
				b: old ? '#e0dcd4' : hair,
				r: pick(ROBES),
				c: pick(TRIMS),
				a: hat === 'guan' ? '#1f1f24' : pick([...ROBES, '#2b2b2b', '#6b6f78']),
				A: pick(TRIMS),
			},
		});
		faces.set(key, art);
	}
	return art;
}
