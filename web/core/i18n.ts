/**
 * Minimal gettext-style i18n. Source strings (English, in code and from the server) are
 * the keys; each plugin registers translations for the locales it supports.
 *
 * Keys may contain placeholders `{0}`, `{1}`... to translate server messages that embed
 * values: "Requires {0} {1}" -> "需要{0} {1}级". Captured values are translated too, so
 * "Requires Agriculture 1" becomes "需要农业 1级" when "Agriculture" has a translation.
 */
import { ref } from 'vue';

export type Messages = Record<string, string>;

const STORAGE_KEY = 'wargame.locale';
export const DEFAULT_LOCALE = 'zh-CN';

function initialLocale(): string {
	try {
		return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_LOCALE;
	} catch {
		return DEFAULT_LOCALE;
	}
}

export function createI18n() {
	const locale = ref(initialLocale());
	const exact = new Map<string, Map<string, string>>(); // locale -> source -> translation
	const patterns = new Map<string, { re: RegExp; to: string; fixed: number }[]>();

	function add(loc: string, messages: Messages) {
		if (!exact.has(loc)) exact.set(loc, new Map());
		if (!patterns.has(loc)) patterns.set(loc, []);
		for (const [from, to] of Object.entries(messages)) {
			if (/\{\d+\}/.test(from)) {
				const source = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{\d+\\\}/g, '(.+?)');
				patterns.get(loc)!.push({ re: new RegExp(`^${source}$`), to, fixed: from.replace(/\{\d+\}/g, '').length });
			} else {
				exact.get(loc)!.set(from, to);
			}
		}
		// Most specific first (the most fixed text), whichever plugin added it: "City limit {0}/{1} · pity {2}/{3}"
		// before "City limit {0}/{1}", so a looser key never swallows a message meant for a longer one.
		patterns.get(loc)!.sort((a, b) => b.fixed - a.fixed);
	}

	/** Translate `text` into the current locale; `vars` fill `{name}` placeholders afterwards. */
	function t(text: string, vars?: Record<string, string | number>): string {
		const loc = locale.value;
		let out = exact.get(loc)?.get(text);
		if (out === undefined) {
			for (const { re, to } of patterns.get(loc) ?? []) {
				const m = re.exec(text);
				if (m) {
					out = to.replace(/\{(\d+)\}/g, (_, i) => t(m[Number(i) + 1] ?? ''));
					break;
				}
			}
		}
		out ??= text;
		return vars ? out.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : out;
	}

	function setLocale(loc: string) {
		locale.value = loc;
		try {
			localStorage.setItem(STORAGE_KEY, loc);
		} catch {
			/* private mode: keep it for this page only */
		}
		document.documentElement.lang = loc;
	}

	document.documentElement.lang = locale.value;
	return { locale, add, t, setLocale, locales: () => [...exact.keys()] };
}
