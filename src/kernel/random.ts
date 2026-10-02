/**
 * Deterministic pseudo-random numbers from a string seed (FNV-1a hash + mulberry32). Use it
 * wherever a "random" result must be the same every time it is computed — in read-only
 * views, and in commands, which may be retried.
 */
export function seededRandom(seed: string): () => number {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
	let a = h >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/**
 * A whole number from a triangular distribution: never below `min` or above `max`, most often near
 * `mode`, averaging (min + mode + max) / 3. `random` gives uniform numbers in [0, 1).
 */
export function triangularInt(min: number, mode: number, max: number, random: () => number): number {
	if (max <= min) return min;
	const u = random();
	const split = (mode - min) / (max - min);
	const x = u < split ? min + Math.sqrt(u * (max - min) * (mode - min)) : max - Math.sqrt((1 - u) * (max - min) * (max - mode));
	return Math.min(max, Math.max(min, Math.round(x)));
}
