import type { PrestigeData, PrestigeRanks, PrestigeStatus } from './api';

/** The rank reached at `best` prestige: the last whose threshold it meets (the first starts at 0). Both ends. */
export function rankAt(ranks: readonly { threshold: number }[], best: number): number {
	let i = 0;
	while (i + 1 < ranks.length && best >= ranks[i + 1].threshold) i++;
	return i;
}

/** The player's prestige with their rank and the next one (the badge's data). */
export function prestigeOf(d: PrestigeData, ranks: PrestigeRanks): PrestigeStatus {
	const i = rankAt(ranks, d.best);
	const next = ranks[i + 1];
	return {
		value: d.value,
		best: d.best,
		rank: { index: i, name: ranks[i].name },
		...(next ? { next: { name: next.name, threshold: next.threshold } } : {}),
	};
}
