// What the items' commands did, in the inventory held in the browser (`game.patchView`). Pure: the tests run it.

/** The inventory with `n` more of `item` (negative: fewer, never below none; none left: not listed, as the server sends it). */
export function counted(owned: Record<string, number>, item: string, n: number): Record<string, number> {
	const left = Math.max(0, (owned[item] ?? 0) + n);
	const { [item]: _, ...rest } = owned;
	return left > 0 ? { ...rest, [item]: left } : rest;
}
