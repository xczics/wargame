/**
 * Level math both ends use: the server for costs and effects, the client to work out cards at any level from the
 * same tables (e.g. a building past its regular cap). Pure functions.
 */

/** A planning-table row: what reaching a level costs and how long it takes. */
export interface PlanRow {
	cost: Record<string, number>;
	seconds: number;
}

/**
 * The row to use for `level` in a planning table whose missing levels (null, or past the
 * end) grow from the nearest lower row: that row and how many levels above it `level` is,
 * e.g. rows up to 7 and level 10 -> row 7, beyond 3 (cost x growth^3).
 */
export function planRow(levels: readonly (PlanRow | null | undefined)[], level: number): { row: PlanRow; beyond: number } {
	let k = Math.max(1, Math.min(level, levels.length));
	while (k > 1 && !levels[k - 1]) k--;
	const row = levels[k - 1];
	if (!row) throw new Error('A planning table needs a level-1 row');
	return { row, beyond: Math.max(0, level - k) };
}

/** A stage of `stagedGrowth`: from level `from` on, each level is `factor` times the one before. */
export interface GrowthStage {
	from: number;
	factor: number;
}

/**
 * A per-level amount that grows faster at higher levels: `perLevel` x level up to the first stage, then each
 * level `factor` times the one before, the factor of the latest stage reached (e.g. warehouse capacity:
 * linear to 5, x1.25 a level from 6, doubling from 16).
 */
export function stagedGrowth(perLevel: number, level: number, stages: readonly GrowthStage[] = []): number {
	const sorted = [...stages].sort((a, b) => a.from - b.from);
	if (!sorted.length || level < sorted[0].from) return perLevel * level;
	let value = perLevel * (sorted[0].from - 1);
	for (let l = sorted[0].from; l <= level; l++) value *= sorted.filter((s) => s.from <= l).at(-1)!.factor;
	return value;
}
