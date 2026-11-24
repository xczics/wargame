// How long a march takes, the same in the Worker (armies.dispatch, its fast path) and the browser (the march a send made,
// the send forms' expected arrival; user 2026-11-24: "行军到达时间……前端是知道的呀").

/** Static view `armies.travel`: the GM's travel rules. */
export interface MarchRules {
	/** Marching speed multiplier (`armies.speed`). */
	speed: number;
	/** On top of it, to one's own settlements (`armies.ownSpeed`). */
	ownSpeed: number;
	/** Shortest time of one way, in seconds (`armies.minSeconds`; none to one's own settlements). */
	minSeconds: number;
}

/** Tiles per hour of the slowest of `units` (those with none left out; `speedOf` undefined: an unknown unit, left out). Infinity: none. */
export function slowestSpeed(units: Record<string, number>, speedOf: (unit: string) => number | undefined): number {
	let slowest = Infinity;
	for (const [u, n] of Object.entries(units)) {
		if (!n) continue;
		const v = speedOf(u);
		if (v !== undefined) slowest = Math.min(slowest, v);
	}
	return slowest;
}

/** One way's seconds at `pace` (tiles per hour) over `distance`; to one's own settlement faster and with no shortest time. */
export const travelSeconds = (distance: number, pace: number, own: boolean, rules: MarchRules) =>
	Math.max(1, own ? 0 : rules.minSeconds, Math.ceil(((distance / pace) * 3600) / (rules.speed * (own ? rules.ownSpeed : 1))));
