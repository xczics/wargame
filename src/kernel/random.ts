import { seededRandom } from '../shared/random';

export { seededRandom };

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
