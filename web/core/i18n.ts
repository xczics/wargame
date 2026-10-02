/**
 * Minimal gettext-style i18n. Source strings (English, in code and from the server) are
 * the keys; each plugin registers translations for the locales it supports.
 *
 * Keys may contain placeholders `{0}`, `{1}`... to translate server messages that embed
 * values: "Requires {0} {1}" -> "需要{0} {1}级". Captured values are translated too, so
 * "Requires Agriculture 1" becomes "需要农业 1级" when "Agriculture" has a translation.
 *
 * People's names travel as name-part keys ("s:Zhao m:Zilong"), alone or inside a text: they are
 * spelled for the locale first (from `setNames`; no space between the parts in Chinese).
 *
 * A key may be namespaced by the plugin it belongs to ("starter-realms.School"), so the same English
 * word can mean different things in different plugins; untranslated, it shows without the plugin id.
 */
import { ref } from 'vue';
import { createCatalog, neutral } from '../../src/shared/i18n';

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
	const catalog = createCatalog();
	let names: Record<string, Record<string, string>> = {};
	let namespaces = new Set<string>();
	/** "plugin-id.Text" -> "Text" when the prefix is a plugin's id; else unchanged. */
	function bare(text: string): string {
		const dot = text.indexOf('.');
		return dot > 0 && namespaces.has(text.slice(0, dot)) ? text.slice(dot + 1) : text;
	}
	const NAMES = /\b(s:[^\s,，]+) ([mf]:[^\s,，]+)/g;
	function spell(text: string): string {
		if (!text.includes('s:')) return text;
		const loc = locale.value;
		const part = (k: string) => names[loc]?.[k] ?? names.en?.[k] ?? k;
		return text.replace(NAMES, (_, sur: string, given: string) =>
			loc.startsWith('zh') ? `${part(sur)}${part(given)}` : `${part(sur)} ${part(given)}`,
		);
	}
	/**
	 * Register translations. A client plugin's own words are its keys "@<plugin>.<text>" (`@`: client plugin
	 * ids may equal server ones, never an `@`), the frame's are "@core.<text>", so two never clash and no
	 * pattern without a prefix can swallow another plugin's text; without `plugin`: the server's (meta,
	 * already "<pluginId>.<key>").
	 */
	function add(loc: string, messages: Messages, plugin?: string) {
		catalog.add(loc, plugin ? Object.fromEntries(Object.entries(messages).map(([k, v]) => [`@${plugin}.${k}`, v])) : messages);
	}

	/**
	 * `text` in locale `loc`, or undefined. A pattern's captures are looked up in its plugin first
	 * ("<id>.<capture>"). `partly`: a pattern may leave parts untranslated (shown as they are).
	 */
	function lookup(text: string, loc: string, partly = false): string | undefined {
		return catalog.lookup(
			text,
			loc,
			(part, ns) =>
				(ns ? lookup(`${ns}.${part}`, loc) : undefined) ?? lookup(spell(part), loc) ?? (neutral(part) ? spell(part) : undefined),
			partly ? (part) => t(part) : undefined,
		);
	}

	/**
	 * Translate `text` into the current locale (else English, else the text without its plugin id): as the
	 * words of client plugin `plugin`, the frame's ("@core.<text>") or a server key. A full translation from
	 * any of them wins over a partial one (a loose pattern like "{0}, {1}" must not swallow a text that has
	 * its own key). `vars` fill `{name}` placeholders afterwards.
	 */
	function t(raw: string, vars?: Record<string, string | number>, plugin = 'core'): string {
		const text = spell(raw);
		const keys = [`@${plugin}.${text}`, ...(plugin !== 'core' ? [`@core.${text}`] : []), text];
		const locales = locale.value !== 'en' ? [locale.value, 'en'] : ['en'];
		let out: string | undefined;
		for (const partly of [false, true]) for (const loc of locales) for (const k of keys) out ??= lookup(k, loc, partly);
		out ??= bare(text);
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
	return {
		locale,
		add,
		t,
		setLocale,
		setNames: (n: typeof names) => void (names = n),
		setNamespaces(ids: string[]) {
			namespaces = new Set(ids);
			catalog.setNamespaces(ids);
		},
		/** Whether `text` has a translation of its own in the current locale or English (not a pattern's). */
		has: (text: string, plugin = 'core') =>
			[`@${plugin}.${text}`, `@core.${text}`, text].some((k) => catalog.has(k, locale.value) || catalog.has(k, 'en')),
		locales: catalog.locales,
	};
}
