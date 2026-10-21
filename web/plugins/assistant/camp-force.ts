// What a raid on a camp sends when the rule says "the camp's garrison × factor" (docs/design/gameplay.md §15.4): every
// lane sent gets the camp's lane garrison times the factor, tier by tier, of one family; which family goes where is
// picked at random among those the settlement can fill (user 2026-10-21: "在能派出的前提下随机选取阵型"). A tier
// short of units is made up with higher tiers of the same family by attack: as many as bring the attack missing, at the
// units' attack under the rules without bonuses (static `troops.attack`; user 2026-10-21: "按默认攻击力比值顶替吧").
// Pure: the tests run it.

export interface ForceUnit {
	id: string;
	family?: string;
	tier?: number;
}

export interface LanePlan {
	family: string;
	units: Record<string, number>;
}

/**
 * One lane of `family` out of `left` (taken from it when it can be filled): the needs tier by tier, then each tier's
 * shortfall made up from the lowest higher tier on.
 */
function fillLane(
	family: string,
	need: Record<number, number>,
	left: Record<string, number>,
	units: ForceUnit[],
	attack: Record<string, number>,
) {
	const own = units.filter((u) => u.family === family && u.tier);
	const byTier = (t: number) => own.filter((u) => u.tier === t);
	const take: Record<string, number> = {};
	const stock = { ...left };
	const draw = (t: number, n: number) => {
		let rest = n;
		for (const u of byTier(t)) {
			const k = Math.min(rest, stock[u.id] ?? 0);
			if (k > 0) {
				stock[u.id] -= k;
				take[u.id] = (take[u.id] ?? 0) + k;
				rest -= k;
			}
		}
		return n - rest;
	};
	const tiers = Object.keys(need)
		.map(Number)
		.sort((a, b) => a - b);
	// What is missing, as attack (one of the family's units of that tier each).
	const short: Record<number, number> = {};
	for (const t of tiers) short[t] = (need[t] - draw(t, need[t])) * Math.max(0, ...byTier(t).map((u) => attack[u.id] ?? 0));
	const top = Math.max(0, ...own.map((u) => u.tier!));
	for (const t of tiers) {
		for (let h = t + 1; h <= top && short[t] > 1e-9; h++)
			for (const u of byTier(h)) {
				const a = attack[u.id] ?? 0;
				if (a <= 0 || short[t] <= 1e-9) continue;
				const k = Math.min(stock[u.id] ?? 0, Math.ceil(short[t] / a - 1e-9));
				if (k <= 0) continue;
				stock[u.id] -= k;
				take[u.id] = (take[u.id] ?? 0) + k;
				short[t] = Math.max(0, short[t] - k * a);
			}
		if (short[t] > 1e-9) return null;
	}
	return { take, stock };
}

/**
 * The lanes to send: `count` lanes (5, or 3 in strength) of `lane` × `factor` each, the rest empty; null when the
 * settlement cannot fill them. `shuffle`: families and places at random; else the strongest family left fills each
 * lane in turn, from lane 1.
 */
export function campLanes(options: {
	lane: Record<string, number>;
	factor: number;
	count: number;
	lanes: number;
	have: Record<string, number>;
	units: ForceUnit[];
	/** Each unit's attack without bonuses (static `troops.attack`). */
	attack: Record<string, number>;
	shuffle: boolean;
	random?: () => number;
}): LanePlan[] | null {
	const { lane, factor, count, lanes, have, units, attack, shuffle } = options;
	const random = options.random ?? Math.random;
	const need: Record<number, number> = {};
	for (const [t, n] of Object.entries(lane)) if (n > 0) need[Number(t)] = Math.ceil(n * factor);
	if (!Object.keys(need).length) return null;
	const families = [...new Set(units.filter((u) => u.family && u.tier && (have[u.id] ?? 0) > 0).map((u) => u.family!))];
	if (!families.length) return null;
	// A family's strength left: its units' attack.
	const strength = (f: string, left: Record<string, number>) =>
		units.filter((u) => u.family === f && u.tier).reduce((a, u) => a + (left[u.id] ?? 0) * (attack[u.id] ?? 0), 0);
	const shuffled = <T>(list: T[]) => {
		const out = [...list];
		for (let i = out.length - 1; i > 0; i--) {
			const j = Math.floor(random() * (i + 1));
			[out[i], out[j]] = [out[j], out[i]];
		}
		return out;
	};
	// Greedy lane by lane; at random a few tries, as one unlucky order can starve a later lane another order fills.
	for (let attempt = 0; attempt < (shuffle ? 30 : 1); attempt++) {
		let left = { ...have };
		const filled: LanePlan[] = [];
		for (let i = 0; i < count; i++) {
			const order = shuffle ? shuffled(families) : [...families].sort((a, b) => strength(b, left) - strength(a, left));
			let done = false;
			for (const f of order) {
				const r = fillLane(f, need, left, units, attack);
				if (!r) continue;
				filled.push({ family: f, units: r.take });
				left = r.stock;
				done = true;
				break;
			}
			if (!done) break;
		}
		if (filled.length < count) continue;
		const empty = (): LanePlan => ({ family: filled[0].family, units: {} });
		const out = [...filled, ...Array.from({ length: lanes - count }, empty)];
		return shuffle ? shuffled(out) : out;
	}
	return null;
}

/** The lanes' units added up (what `armies.send` takes as `units`). */
export const laneTotals = (plan: LanePlan[]) => {
	const out: Record<string, number> = {};
	for (const l of plan) for (const [u, n] of Object.entries(l.units)) out[u] = (out[u] ?? 0) + n;
	return out;
};
