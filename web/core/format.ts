const SUFFIXES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];

/** Idle-game number formatting: 999, 1.23K, 45.6M, ... then scientific. */
export function formatNumber(n: number, { decimals = 0 }: { decimals?: number } = {}): string {
	if (!Number.isFinite(n)) return '∞';
	const sign = n < 0 ? '-' : '';
	n = Math.abs(n);
	if (n < 1000) return sign + (decimals ? n.toFixed(decimals).replace(/\.0+$/, '') : Math.floor(n).toString());
	const tier = Math.floor(Math.log10(n) / 3);
	if (tier >= SUFFIXES.length) return sign + n.toExponential(2);
	const scaled = n / 1000 ** tier;
	return sign + scaled.toFixed(scaled < 10 ? 2 : scaled < 100 ? 1 : 0) + SUFFIXES[tier];
}

/** A moment in the game's language (the page's `lang`, set by the i18n core), not the browser's. */
export const formatTime = (ms: number | null | undefined) =>
	ms ? new Date(ms).toLocaleString(document.documentElement.lang || undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—';

/** A day in the game's language ("2026年10月20日", "Oct 20, 2026"). */
export const formatDate = (ms: number) =>
	new Date(ms).toLocaleDateString(document.documentElement.lang || undefined, { dateStyle: 'long' });
