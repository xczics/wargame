/**
 * Plain formatting both ends use for the texts of generic widgets (the server puts numbers into
 * UiText vars already formatted; the client only translates). No locale-specific words here.
 */

/** "45s", "3m 20s", "2h 5m". */
export function duration(seconds: number): string {
	const s = Math.max(0, Math.ceil(seconds));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/** "1,234" (whole numbers) or with `decimals`. */
export function amount(n: number, decimals = 0): string {
	return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals });
}

/** A cost or upkeep as "🪨250 🪵750" (`icons` by resource id; zero amounts left out). */
export function amounts(cost: Record<string, number>, icons: Record<string, string>, decimals = 0): string {
	return Object.entries(cost)
		.filter(([, n]) => n > 0)
		.map(([r, n]) => `${icons[r] ?? r}${amount(n, decimals)}`)
		.join(' ');
}
