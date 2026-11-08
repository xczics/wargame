// "Develop a settlement" (user 2026-11-08: "小助手建筑功能，新加'新城开发'功能"): what to build in which empty slot,
// worked out from what the browser holds (the settlement's buildings, its outer city's terrain, the static catalog),
// then queued level by level like any task. Pure: the tests run it.
//   - an outer city's resource buildings, by a strategy: even, one kind only (focus), more where the terrain helps and
//     fewer where it hurts (favour), or the reverse (against), the lean of the last two as the player picks;
//   - a city or fortress: how many of each building that may stand more than once.

export type Strategy = 'even' | 'focus' | 'favour' | 'against';
/**
 * How much "more" and "fewer" is (favour / against): twice as many and half as many (`double`), `n` more and `n` fewer
 * than even (`shift`), or `n` slots shared out by the terrain's percents, the rest even (`auto`).
 */
export type Lean = { kind: 'double' } | { kind: 'shift'; n: number } | { kind: 'auto'; n: number };

/** `total` shared out in proportion to `weights` (largest remainders; ties to the earlier key). */
export function shareOut(total: number, weights: Record<string, number>): Record<string, number> {
	const keys = Object.keys(weights);
	const sum = keys.reduce((n, k) => n + Math.max(0, weights[k]), 0);
	const out = Object.fromEntries(keys.map((k) => [k, 0]));
	if (total <= 0 || !keys.length) return out;
	if (sum <= 0) return shareOut(total, Object.fromEntries(keys.map((k) => [k, 1])));
	const exact = keys.map((k) => ({ k, v: (total * Math.max(0, weights[k])) / sum }));
	for (const e of exact) out[e.k] = Math.floor(e.v);
	let left = total - keys.reduce((n, k) => n + out[k], 0);
	for (const e of [...exact].sort((a, b) => b.v - Math.floor(b.v) - (a.v - Math.floor(a.v)) || keys.indexOf(a.k) - keys.indexOf(b.k))) {
		if (left <= 0) break;
		out[e.k]++;
		left--;
	}
	return out;
}

/**
 * How many of each resource building an outer city's `total` slots should hold. `bonus`: the terrain's percent by
 * building (from what it produces; negative: a debuff). `focus`: the one kind of `focus`.
 */
export function resourceTargets(o: {
	total: number;
	buildings: readonly string[];
	bonus: Record<string, number>;
	strategy: Strategy;
	focus?: string;
	lean: Lean;
}): Record<string, number> {
	const ones = Object.fromEntries(o.buildings.map((b) => [b, 1]));
	if (o.strategy === 'even' || !o.buildings.length) return shareOut(o.total, ones);
	if (o.strategy === 'focus') return Object.fromEntries(o.buildings.map((b) => [b, b === o.focus ? o.total : 0]));
	// Favour: the terrain's sign as it is; against: reversed (more where it hurts, fewer where it helps).
	const sign = (b: string) => Math.sign(o.bonus[b] ?? 0) * (o.strategy === 'against' ? -1 : 1);
	if (o.lean.kind === 'double')
		return shareOut(o.total, Object.fromEntries(o.buildings.map((b) => [b, sign(b) > 0 ? 2 : sign(b) < 0 ? 0.5 : 1])));
	if (o.lean.kind === 'auto') {
		const n = Math.min(o.total, Math.max(0, o.lean.n));
		const base = shareOut(o.total - n, ones);
		const by = Object.fromEntries(o.buildings.map((b) => [b, Math.max(0, (o.bonus[b] ?? 0) * (o.strategy === 'against' ? -1 : 1))]));
		const extra = shareOut(n, by);
		return Object.fromEntries(o.buildings.map((b) => [b, base[b] + extra[b]]));
	}
	// Shift: n more where it helps, n fewer where it hurts (not below 0), the difference to the total over the others.
	const out = shareOut(o.total, ones);
	for (const b of o.buildings) out[b] = Math.max(0, out[b] + sign(b) * o.lean.n);
	let diff = o.total - o.buildings.reduce((n, b) => n + out[b], 0);
	const neutral = o.buildings.filter((b) => sign(b) === 0);
	const pool = neutral.length
		? neutral
		: o.buildings.filter((b) => sign(b) > 0).length
			? o.buildings.filter((b) => sign(b) > 0)
			: [...o.buildings];
	for (let i = 0; diff !== 0 && i < 10_000; i++) {
		const b = pool[i % pool.length];
		if (diff > 0) (out[b]++, diff--);
		else if (out[b] > 0) (out[b]--, diff++);
		else if (pool.every((x) => out[x] === 0)) break;
	}
	return out;
}

/**
 * Which building goes in which empty slot, to bring what stands (`have`) up to `target`: each empty slot to the
 * building furthest below its count that the slot accepts (ties to the earlier building). What stands stays.
 */
export function fillSlots(
	empty: readonly { key: string; accepts: readonly string[] }[],
	have: Record<string, number>,
	target: Record<string, number>,
): { key: string; building: string }[] {
	const short = Object.fromEntries(Object.entries(target).map(([b, n]) => [b, Math.max(0, n - (have[b] ?? 0))]));
	const order = Object.keys(target);
	const out: { key: string; building: string }[] = [];
	for (const slot of empty) {
		const pick = order
			.filter((b) => short[b] > 0 && slot.accepts.includes(b))
			.sort((a, b) => short[b] - short[a] || order.indexOf(a) - order.indexOf(b))[0];
		if (!pick) continue;
		out.push({ key: slot.key, building: pick });
		short[pick]--;
	}
	return out;
}
