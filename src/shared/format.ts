/**
 * Plain formatting both ends use for the texts of generic widgets (the server puts numbers into
 * UiText vars already formatted; the client only translates). No locale-specific words here.
 */

/** "45s", "3m 20s", "2h 5m". */
export function duration(seconds: number): string {
	const s = Math.max(0, Math.ceil(seconds));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

// One formatter per number of decimals: `toLocaleString` with options builds a new one on every call, and the
// views format thousands of numbers a sync (it was the largest CPU cost of the city page).
const formatters = new Map<number, Intl.NumberFormat>();

/** "1,234" (whole numbers) or with `decimals`. */
export function amount(n: number, decimals = 0): string {
	let f = formatters.get(decimals);
	if (!f) formatters.set(decimals, (f = new Intl.NumberFormat('en-US', { minimumFractionDigits: 0, maximumFractionDigits: decimals })));
	return f.format(n);
}

/** "1,234": rounded down (prestige, coupons: never shown more than one has). */
export function whole(n: number): string {
	return amount(Math.floor(n));
}

/** "+2.5", "−3%": a change, always with its sign (a real minus). */
export function signed(n: number, percent = false, decimals = 2): string {
	return `${n >= 0 ? '+' : '−'}${amount(Math.abs(n), decimals)}${percent ? '%' : ''}`;
}

/** A cost or upkeep as "🪨250 🪵750" (`icons` by resource id; zero amounts left out). */
export function amounts(cost: Record<string, number>, icons: Record<string, string>, decimals = 0): string {
	return Object.entries(cost)
		.filter(([, n]) => n > 0)
		.map(([r, n]) => `${icons[r] ?? r}${amount(n, decimals)}`)
		.join(' ');
}

/** A cost as parts of a widget button: one per resource ("🪨800"), "warn" where `have` (if given) falls short. */
/** "🪵750": one resource of a price (its icon, then the amount). */
export const costText = (icon: string, n: number) => `${icon}${amount(n)}`;

export function costParts(
	cost: Record<string, number>,
	icons: Record<string, string>,
	have?: Record<string, number>,
): { text: { text: string }; tone?: 'warn' }[] {
	return Object.entries(cost)
		.filter(([, n]) => n > 0)
		.map(([r, n]) => ({
			text: { text: costText(icons[r] ?? r, n) },
			...(have && (have[r] ?? 0) < n ? { tone: 'warn' as const } : {}),
		}));
}
