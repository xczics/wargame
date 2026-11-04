/**
 * Minimal gettext-style i18n. Every text has a key: the server's are "<pluginId>.<key>" (sent as UiTexts,
 * src/shared/i18n.ts), a client plugin's own words "@<plugin>.<text>", the frame's "@core.<text>". A key is
 * looked up as it is, never guessed from a text built around it; untranslated, it shows in English, else
 * without its plugin id.
 *
 * Keys may hold placeholders (`{0}`, `{name}`) filled from the vars afterwards. People's names travel as
 * name-part keys ("s:Zhao m:Zilong"): they are spelled for the locale (from `setNames`; no space between the
 * parts in Chinese).
 */
import { ref } from 'vue';
import { costPlain } from '../../src/shared/format';
import type { UiCostVar, UiIconVar, UiText } from '../../src/shared/ui';

export type Messages = Record<string, string>;

/** A piece of a drawn text: words, an icon or a cost. */
export type TextFragment = string | UiIconVar | UiCostVar;

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
	const tables = new Map<string, Map<string, string>>(); // locale -> key -> text
	let names: Record<string, Record<string, string>> = {};
	let namespaces = new Set<string>();
	/** "plugin-id.Text" -> "Text" when the prefix is a plugin's id; else unchanged. */
	function bare(text: string): string {
		const dot = text.indexOf('.');
		return dot > 0 && namespaces.has(text.slice(0, dot)) ? text.slice(dot + 1) : text;
	}
	const NAMES = /\b(s:[^\s,，]+) ([mf]:[^\s,，]+)/g;
	/** A name a player gave (a hero renamed): "n:<encoded>", shown as typed. */
	const OWN = /\bn:([^\s,，]+)/g;
	const decode = (s: string) => {
		try {
			return decodeURIComponent(s);
		} catch {
			return s;
		}
	};
	function spell(text: string): string {
		if (text.includes('n:')) text = text.replace(OWN, (_, enc: string) => decode(enc));
		if (!text.includes('s:')) return text;
		const loc = locale.value;
		const part = (k: string) => names[loc]?.[k] ?? names.en?.[k] ?? k;
		return text.replace(NAMES, (_, sur: string, given: string) =>
			loc.startsWith('zh') ? `${part(sur)}${part(given)}` : `${part(sur)} ${part(given)}`,
		);
	}
	/**
	 * Register translations. A client plugin's own words are its keys "@<plugin>.<text>" (`@`: client plugin
	 * ids may equal server ones, never an `@`), the frame's are "@core.<text>", so two never clash; without
	 * `plugin`: the server's (meta, already "<pluginId>.<key>").
	 */
	function add(loc: string, messages: Messages, plugin?: string) {
		const table = tables.get(loc) ?? new Map<string, string>();
		tables.set(loc, table);
		for (const [k, v] of Object.entries(messages)) table.set(plugin ? `@${plugin}.${k}` : k, v);
		spelled.clear();
	}
	// Each text's template once per locale and plugin (the map's tiles, the cards and the bars ask the same thousands of
	// times; a new locale or new messages start it over).
	const spelled = new Map<string, string>();
	let spelledFor = '';

	/**
	 * Translate `raw` into the current locale (else English, else the text without its plugin id): as a word of
	 * client plugin `plugin`, of the frame ("@core.<text>") or a server key. `vars` fill `{name}` placeholders.
	 */
	function t(raw: string, vars?: Record<string, string | number>, plugin = 'core'): string {
		if (spelledFor !== locale.value) (spelled.clear(), (spelledFor = locale.value));
		const cacheKey = `${plugin}|${raw}`;
		let out = spelled.get(cacheKey);
		if (out === undefined) {
			const text = spell(raw);
			const keys = [`@${plugin}.${text}`, ...(plugin !== 'core' ? [`@core.${text}`] : []), text];
			const locales = locale.value !== 'en' ? [locale.value, 'en'] : ['en'];
			for (const loc of locales) for (const k of keys) out ??= tables.get(loc)?.get(k);
			out ??= bare(text);
			spelled.set(cacheKey, out);
		}
		return vars ? out.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? `{${k}}`)) : out;
	}

	/**
	 * A server text (UiText) where only text fits (a tooltip, a dropdown's option, the tab's title): its key's
	 * template, the vars filled in (texts translated, lists joined, icons left out, costs named).
	 */
	function text(ui: UiText, plugin = 'core'): string {
		return fragments(ui, plugin)
			.map((f) => (typeof f === 'string' ? f : 'icon' in f ? '' : costPlain(f, (k) => t(k, undefined, plugin))))
			.join('')
			.replace(/ {2,}/g, ' ')
			.trim();
	}

	/**
	 * A server text as it is drawn (web/widgets/Txt.vue): runs of words, and the icons and costs between them. Its
	 * template is translated once; a var that is a text is translated in place (its own icons kept).
	 */
	function fragments(ui: UiText, plugin = 'core'): TextFragment[] {
		const template = t(ui.text, undefined, plugin);
		if (!ui.vars) return [template];
		const out: TextFragment[] = [];
		const push = (f: TextFragment) =>
			typeof f === 'string' && typeof out[out.length - 1] === 'string' ? (out[out.length - 1] += f) : f !== '' && out.push(f);
		let last = 0;
		for (const m of template.matchAll(/\{(\w+)\}/g)) {
			push(template.slice(last, m.index));
			last = m.index! + m[0].length;
			const v = ui.vars[m[1]];
			if (v === undefined) push(m[0]);
			else if (Array.isArray(v))
				v.forEach((x, i) => {
					if (i) push(t(', ', undefined, plugin));
					fragments(x, plugin).forEach(push);
				});
			else if (typeof v === 'object') ('text' in v ? fragments(v, plugin) : [v]).forEach(push);
			else push(typeof v === 'string' ? spell(v) : String(v));
		}
		push(template.slice(last));
		return out;
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
		text,
		fragments,
		setLocale,
		setNames: (n: typeof names) => void ((names = n), spelled.clear()),
		setNamespaces: (ids: string[]) => void ((namespaces = new Set(ids)), spelled.clear()),
		/** Whether `text` has a translation in the current locale or English. */
		has: (text: string, plugin = 'core') =>
			[`@${plugin}.${text}`, `@core.${text}`, text].some((k) => tables.get(locale.value)?.has(k) || tables.get('en')?.has(k)),
		locales: () => [...tables.keys()],
	};
}
