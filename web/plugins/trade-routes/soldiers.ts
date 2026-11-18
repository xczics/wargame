// Pixel soldiers for the trade routes' fights (user 2026-11-16: "像素小兵对阵"): a column drawn as a small squad of its
// family, fewer figures as it loses its hp; ours face right, theirs left. Pure: the tests run it.
import type { Box, PixelLayer } from '../../widgets/pixels';

const INFANTRY = [
	'.......w....',
	'...hh..w....',
	'..hhhh.w....',
	'...ss..w....',
	'..aaaasw....',
	'ddaaaa.w....',
	'dDdaaa.w....',
	'dDdaaa.w....',
	'ddaaaa.w....',
	'..a..a......',
	'..a..a......',
	'.oo..oo.....',
];
const ARCHER = [
	'........b...',
	'...hh....b..',
	'..hhhh...wb.',
	'...ss....w.b',
	'..aaaasssw.b',
	'..aaaa...w.b',
	'..aaaa...w.b',
	'..aaaa...wb.',
	'..aaaa...b..',
	'..a..a..b...',
	'..a..a......',
	'.oo..oo.....',
];
const CAVALRY = [
	'....hh..........',
	'...hhhh.........',
	'....ss.......w..',
	'...aaaa.....w...',
	'..saaaas...w....',
	'....aa....w.....',
	'..nnnnnnnn...nn.',
	'.nnnnnnnnnnnnnnn',
	'.nnnnnnnnnnn..n.',
	'..n.n....n.n....',
	'..n.n....n.n....',
	'.oo.oo..oo.oo...',
];
const FIGURES: Record<string, string[]> = { infantry: INFANTRY, archer: ARCHER, cavalry: CAVALRY };

const COMMON = { s: '#e0b48a', w: '#8a5a2b', b: '#6b4423', n: '#7a5232', o: '#3a2a1a', d: '#9a7b3c', D: '#e6d18a' };
const SIDES = {
	ours: { ...COMMON, a: '#3b6fb6', h: '#2c4a7a' },
	theirs: { ...COMMON, a: '#a33a2c', h: '#5e2a20' },
};

const mirror = (rows: string[]) => rows.map((r) => [...r].reverse().join(''));

/** Figures a column shows: up to six, by the share of its hp left (one while it stands at all). */
export const figures = (hp: number, max: number) => (hp <= 0 ? 0 : Math.max(1, Math.ceil((6 * hp) / (max || 1))));

/** A squad of `count` figures of a family (units of other families: infantry), two ranks, for `PixelArt`. */
export function squad(family: string | undefined, side: 'ours' | 'theirs', count: number): { layers: PixelLayer[]; box: Box } {
	const base = FIGURES[family ?? ''] ?? INFANTRY;
	const rows = side === 'ours' ? base : mirror(base);
	const w = rows[0].length;
	const palette = SIDES[side];
	const layers: PixelLayer[] = [];
	// Back rank first (drawn over by the front one), staggered.
	for (let i = 0; i < count; i++) {
		const rank = i % 2;
		const file = Math.floor(i / 2);
		layers.push({ sprite: { x: file * (w - 3) + (rank ? 0 : 3), y: rank ? 0 : 5, rows }, palette });
	}
	layers.sort((a, b) => a.sprite.y - b.sprite.y);
	return { layers, box: [0, 0, 3 * (w - 3) + 6, rows.length + 5] };
}
