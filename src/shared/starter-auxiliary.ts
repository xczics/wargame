// The starter auxiliary units' rules both ends work out: the server's pace modifier (src/plugins/starter-auxiliary) and
// its browser counterpart (web/plugins/starter-auxiliary), so a march's arrival is the same on both.

/**
 * Carts: the fastest carts take the slowest units (not other carts), who then go at the cart's speed. `seats`: units one
 * cart of each kind carries; `speedOf`: each unit's march speed for the player. Null: no carts in `units`.
 */
export function cartPace(units: Record<string, number>, speedOf: (unit: string) => number, seats: Record<string, number>): number | null {
	const fleet = Object.keys(seats)
		.filter((id) => units[id])
		.map((id) => ({ speed: speedOf(id), seats: seats[id] * units[id] }))
		.sort((a, b) => b.speed - a.speed);
	if (!fleet.length) return null;
	const walkers = Object.entries(units)
		.filter(([id, n]) => n > 0 && !Object.hasOwn(seats, id))
		.map(([id, n]) => ({ speed: speedOf(id), n }))
		.sort((a, b) => a.speed - b.speed);
	let pace = Math.min(...fleet.map((c) => c.speed));
	let c = 0;
	for (const w of walkers) {
		let left = w.n;
		// Only worth a seat when the cart is faster.
		while (left > 0 && c < fleet.length && fleet[c].speed > w.speed) {
			const take = Math.min(left, fleet[c].seats);
			left -= take;
			fleet[c].seats -= take;
			pace = Math.min(pace, fleet[c].speed);
			if (!fleet[c].seats) c++;
		}
		if (left > 0) pace = Math.min(pace, w.speed);
	}
	return pace;
}
