import { abbreviated } from '../../src/shared/format';

/** Idle-game number formatting (the resource bar): 999, 1.23K, 45.6M, ... then scientific. */
export function formatNumber(n: number, { decimals = 0 }: { decimals?: number } = {}): string {
	if (!Number.isFinite(n)) return '∞';
	if (Math.abs(n) >= 1000) return abbreviated(n);
	const sign = n < 0 ? '-' : '';
	n = Math.abs(n);
	return sign + (decimals ? n.toFixed(decimals).replace(/\.0+$/, '') : Math.floor(n).toString());
}

// One formatter per language and style: `toLocaleString` with options builds a new one each call (lists of hundreds).
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatter = (style: 'time' | 'date') => {
	const lang = document.documentElement.lang || '';
	const key = `${lang}|${style}`;
	let f = formatters.get(key);
	if (!f)
		formatters.set(
			key,
			(f = new Intl.DateTimeFormat(
				lang || undefined,
				style === 'time' ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'long' },
			)),
		);
	return f;
};

/** A moment in the game's language (the page's `lang`, set by the i18n core), not the browser's. */
export const formatTime = (ms: number | null | undefined) => (ms ? formatter('time').format(ms) : '—');

/** A day in the game's language ("2026年10月20日", "Oct 20, 2026"). */
export const formatDate = (ms: number) => formatter('date').format(ms);
