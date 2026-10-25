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

/**
 * "0.0066", "0.33", "12.5": small numbers to two significant digits (one decimal from 1 on), so a value below 0.05 does
 * not show as "0" (1.4.1: realms' loot values, 0.006-0.066, all read "0").
 */
export function significant(n: number): string {
	if (n === 0 || Math.abs(n) >= 1) return amount(n, 1);
	return amount(n, Math.min(8, 1 - Math.floor(Math.log10(Math.abs(n)))));
}

/**
 * A number sent as data, cut to 4 decimals: no float noise in the views ("1.2000000000000002"), finer than any shown
 * value (the browser rounds further when it formats it).
 */
export const precise = (n: number) => Math.round(n * 1e4) / 1e4;

/** "1,234": rounded down (prestige, coupons: never shown more than one has). */
export function whole(n: number): string {
	return amount(Math.floor(n));
}

const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
/** Where numbers start to read "146K" (`readable`, prices). */
export const ABBREVIATE_FROM = 10_000;

/** "1.23K", "146K", "45.6M": three significant digits and a suffix by thousands; past the suffixes, scientific. */
export function abbreviated(n: number): string {
	if (!Number.isFinite(n)) return '∞';
	const sign = n < 0 ? '-' : '';
	const a = Math.abs(n);
	if (a < 1000) return sign + amount(a);
	const tier = Math.floor(Math.log10(a) / 3);
	if (tier >= SUFFIXES.length) return sign + a.toExponential(2);
	const scaled = a / 1000 ** tier;
	const digits = scaled.toFixed(scaled < 10 ? 2 : scaled < 100 ? 1 : 0);
	// "1.2K", not "1.20K" (only the decimals' zeros: "120K" stays).
	return sign + (digits.includes('.') ? digits.replace(/\.?0+$/, '') : digits) + SUFFIXES[tier];
}

/**
 * "12.5", "0.33", "8,140", "146K": as many decimals as the number's size warrants (none from 100 on, one from 10, two
 * below), abbreviated from `ABBREVIATE_FROM` on: for worked-out values (a capacity of 146,484.38 reads "146K").
 */
export function readable(n: number): string {
	const a = Math.abs(n);
	return a >= ABBREVIATE_FROM ? abbreviated(n) : amount(n, a >= 100 ? 0 : a >= 10 ? 1 : 2);
}

/** "+2.5", "−3%": a change, always with its sign (a real minus); decimals by its size (`readable`) unless given. */
export function signed(n: number, percent = false, decimals?: number): string {
	return `${n >= 0 ? '+' : '−'}${decimals === undefined ? readable(Math.abs(n)) : amount(Math.abs(n), decimals)}${percent ? '%' : ''}`;
}

/** A cost or upkeep as "🪨250 🪵750" (`icons` by resource id; zero amounts left out). */
export function amounts(cost: Record<string, number>, icons: Record<string, string>, decimals = 0): string {
	return Object.entries(cost)
		.filter(([, n]) => n > 0)
		.map(([r, n]) => `${icons[r] ?? r}${n >= ABBREVIATE_FROM ? abbreviated(n) : amount(n, decimals)}`)
		.join(' ');
}

/** The `icons` for `amounts` from the resources (the meta's in the browser): a resource without one shows its id. */
export const resourceIcons = (resources: readonly { id: string; icon?: string }[]): Record<string, string> =>
	Object.fromEntries(resources.map((r) => [r.id, r.icon ?? r.id]));

/** "🪵750": one resource of a price (its icon, then the amount). */
export const costText = (icon: string, n: number) => `${icon}${n >= ABBREVIATE_FROM ? abbreviated(n) : amount(n)}`;

/**
 * A price as parts of a widget button: one per resource, counted against the player's (counter `resource:<id>`) by the
 * cards and rows in the browser, red when short (src/shared/statics.ts).
 */
export const costNeeds = (cost: Record<string, number>, icons: Record<string, string>) =>
	Object.entries(cost)
		.filter(([, n]) => n > 0)
		.map(([r, n]) => ({ need: { counter: `resource:${r}`, amount: n, icon: icons[r] ?? r } }));
