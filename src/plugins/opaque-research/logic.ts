/**
 * The arithmetic of opaque research (docs/design/gameplay.md §14), pure: no storage, no rules lookup. A player's hidden
 * values are 256 numbers on a ring; thresholds grow like Fibonacci's; a project's points go partly to its centre
 * (the sprint) and partly to fill the lowest of the dimensions around it.
 */

export const DIMENSIONS = 256;

export interface Tuning {
	/** The first two thresholds; then each is the sum of the two before (5, 8, 13, 21...). */
	thresholds: [number, number];
	/** Base points by tier (1 = the lowest). */
	points: Record<number, number>;
	/** Points x a factor from the hero's learning: min at 0, max at `full` and above; then x (1 ± jitter). */
	spread: { min: number; max: number; full: number; jitter: number };
	/** Share of the points on the centre: base + perCunning x (cunning - 50) - lead x (how far the centre leads), within min..max. */
	sprint: { base: number; perCunning: number; lead: number; min: number; max: number; window: number };
	/** Other projects push targets away: x (1 - depth x e^(-d^2 / 2 sigma^2)) for each, d the ring distance to its centre. */
	avoid: { depth: number; sigma: number };
	/** What the review says when nothing is promised (0-1). */
	fixedRate: number;
	/** Most thresholds one project may cross, by tier (all dimensions together): points beyond are lost. */
	caps: Record<number, number>;
}

/** The thresholds a value has passed (5, 8, 13...: a value of 10 has passed 2). */
export function passed(value: number, [a, b]: [number, number]): number {
	let n = 0;
	let x = a;
	let y = b;
	while (x <= value && n < 200) {
		n++;
		[x, y] = [y, x + y];
	}
	return n;
}
/** The next threshold above a value. */
export function nextThreshold(value: number, [a, b]: [number, number]): number {
	let x = a;
	let y = b;
	while (x <= value) [x, y] = [y, x + y];
	return x;
}

export const ringDistance = (i: number, j: number) => {
	const d = Math.abs(i - j) % DIMENSIONS;
	return Math.min(d, DIMENSIONS - d);
};
export const wrapDim = (i: number) => ((i % DIMENSIONS) + DIMENSIONS) % DIMENSIONS;

/** How much other projects (their centres) push a dimension away: 1 = not at all. */
export function avoidance(i: number, centres: number[], { depth, sigma }: Tuning['avoid']): number {
	let f = 1;
	for (const c of centres) {
		const d = ringDistance(i, c);
		f *= 1 - depth * Math.exp(-(d * d) / (2 * sigma * sigma));
	}
	return f;
}

/** The dimensions around a centre (not the centre itself), `w` each side. */
const around = (c: number, w: number) => Array.from({ length: 2 * w }, (_, k) => wrapDim(c + (k < w ? k - w : k - w + 1)));

/** Share of a project's points that goes to its centre (the rest fills around it). */
export function sprintShare(values: number[], centre: number, cunning: number, t: Tuning): number {
	const s = t.sprint;
	const others = around(centre, s.window).map((i) => values[i]);
	const mean = others.reduce((a, b) => a + b, 0) / others.length;
	// How far the centre leads its neighbours, against the size of its next step.
	const lead = Math.max(0, values[centre] - mean) / nextThreshold(values[centre], t.thresholds);
	return Math.min(s.max, Math.max(s.min, s.base + s.perCunning * (cunning - 50) - s.lead * lead));
}

/** The points a tier's project brings, as a range (uniform: the hero's learning, give or take the jitter). */
export function pointRange(tier: number, learning: number, t: Tuning): [number, number] {
	const sp = t.spread;
	const factor = sp.min + (sp.max - sp.min) * Math.min(1, Math.max(0, learning / sp.full));
	const base = (t.points[tier] ?? 0) * factor;
	return [base * (1 - sp.jitter), base * (1 + sp.jitter)];
}

export interface Choice {
	target: number;
	/** The target's next threshold is within reach: the application promises to break through. */
	promise: boolean;
	/** The review's rate (0-1): the chance the points get the centre past its next threshold, offset aside. */
	rate: number;
	/** How far the target is from its next threshold, against the threshold's size (0 = there). */
	gap: number;
	/** How far it leads its neighbours (positive) or trails them. */
	lead: number;
}

/**
 * The hero's pick: the dimension whose next threshold is nearest and still within reach of what the project may bring
 * (`range`), pushed away from other projects (`centres`); none in reach: the lowest dimension, promising nothing.
 */
export function choose(
	values: number[],
	range: [number, number],
	cunning: number,
	centres: number[],
	t: Tuning,
	random: () => number,
): Choice {
	let best = -1;
	let bestScore = -Infinity;
	for (let i = 0; i < DIMENSIONS; i++) {
		const gap = nextThreshold(values[i], t.thresholds) - values[i];
		if (sprintShare(values, i, cunning, t) * range[1] < gap) continue;
		// Nearer thresholds first; a little noise so ties do not always go to the first dimension.
		const score = (avoidance(i, centres, t.avoid) / gap) * (1 + random() * 1e-6);
		if (score > bestScore) [best, bestScore] = [i, score];
	}
	const promise = best >= 0;
	if (!promise) {
		let low = Infinity;
		for (let i = 0; i < DIMENSIONS; i++) {
			const v = values[i] / avoidance(i, centres, t.avoid) + random() * 1e-6;
			if (v < low) [best, low] = [i, v];
		}
	}
	const next = nextThreshold(values[best], t.thresholds);
	const gap = next - values[best];
	const share = sprintShare(values, best, cunning, t);
	const need = gap / share;
	const rate = promise
		? Math.min(1, Math.max(0, range[1] === range[0] ? (range[0] >= need ? 1 : 0) : (range[1] - need) / (range[1] - range[0])))
		: t.fixedRate;
	const others = around(best, t.sprint.window).map((i) => values[i]);
	const mean = others.reduce((a, b) => a + b, 0) / others.length;
	return { target: best, promise, rate, gap: gap / next, lead: values[best] - mean };
}

/**
 * Where a project's points go: `share` of them on the centre, the rest filling the lowest dimensions around it first
 * (like water: the lowest raised to the next lowest, then together). Returns the new values.
 */
export function allocate(values: number[], centre: number, points: number, share: number, window: number): number[] {
	const out = [...values];
	out[centre] += points * share;
	let left = points * (1 - share);
	const near = around(centre, window).sort((a, b) => out[a] - out[b]);
	for (let k = 1; k <= near.length && left > 1e-9; k++) {
		// Raise the k lowest together to the next one up (or as far as what is left goes).
		const level = out[near[k - 1]];
		const ceiling = k < near.length ? out[near[k]] : Infinity;
		const room = (ceiling - level) * k;
		const step = Math.min(room, left) / k;
		for (let j = 0; j < k; j++) out[near[j]] = level + step;
		left -= step * k;
	}
	return out.map((v) => Math.round(v * 100) / 100);
}

/** The group of a dimension: `groups` runs round the ring in order, as even as can be (sizes differ by one at most). */
export const groupOf = (dim: number, groups: number) => Math.floor((dim * groups) / DIMENSIONS);

const stepsOf = (values: number[], t: [number, number]) => values.reduce((n, v) => n + passed(v, t), 0);

/**
 * `allocate`, crossing at most `cap` thresholds in all: if all the points would cross more, only as many as keep
 * within it are used (crossings only grow with points: found by halving), the rest lost. Returns the values and the
 * points used.
 */
export function allocateCapped(
	values: number[],
	centre: number,
	points: number,
	share: number,
	window: number,
	thresholds: [number, number],
	cap: number,
): { values: number[]; used: number } {
	const before = stepsOf(values, thresholds);
	const within = (p: number) => stepsOf(allocate(values, centre, p, share, window), thresholds) - before <= cap;
	if (within(points)) return { values: allocate(values, centre, points, share, window), used: points };
	let [lo, hi] = [0, points];
	for (let i = 0; i < 30; i++) {
		const mid = (lo + hi) / 2;
		if (within(mid)) lo = mid;
		else hi = mid;
	}
	return { values: allocate(values, centre, lo, share, window), used: lo };
}

/** Thresholds passed in each group. */
export function groupSteps(values: number[], groups: number, thresholds: [number, number]): number[] {
	const out = Array<number>(groups).fill(0);
	for (let i = 0; i < DIMENSIONS; i++) out[groupOf(i, groups)] += passed(values[i], thresholds);
	return out;
}

/** A normal draw (Box–Muller from two uniform ones), rounded and kept within ±max: where a project lands off its target. */
export function offsetDraw(random: () => number, sigma: number, max: number): number {
	const u = Math.max(1e-12, random());
	const v = random();
	const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
	return Math.max(-max, Math.min(max, Math.round(z * sigma)));
}
