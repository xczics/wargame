/**
 * Translations of every plugin (docs/development.md §2.6), user 2026-10-02: "所有插件注册的i18n必须是
 * key+英文+中文。key由插件管理，但统一前缀由内核或者i18n自动添加。使得不同插件之间不会key冲突，同一插件由key冲突的话拒绝加载".
 *
 *   - A plugin ships `data/i18n.csv`: `key` (its own id for the text), `en` (the English) and a column per
 *     locale (`zh-CN`, any others it likes), and registers it with `addCsv(csv, ctx.pluginId)`. Each key
 *     becomes "<pluginId>.<key>": plugins never clash; a key twice in one plugin is refused.
 *   - What the server sends to be shown is such a key: content names are made one by `own()` when other
 *     plugins define them (buildings, units...), a plugin's own messages by their owner (`GameError`'s
 *     `owner`, a view's or command's plugin; see web/core/game.ts).
 *   - Translation slot: `inject(csv)` lets any plugin (e.g. a community translation) add or replace
 *     texts of any plugin by full key ("starter-content.Farm") and locale, without touching official
 *     code. Two injections that disagree are refused.
 *
 * Keys may hold placeholders `{0}`, `{1}` filled from a UiText's vars ("Requires {0} Lv {1}").
 * Served in meta `i18n` as { locale: { "<pluginId>.<key>": text } }.
 */
import { csvRows, definePlugin, PluginError } from '../../kernel';
import type { UiText } from '../../shared/ui';
import i18nCsv from './data/i18n.csv?raw';
import kernelCsv from '../../kernel/i18n.csv?raw';

export interface I18nService {
	/** Register plugin `owner`'s table (columns key, en, then locales); keys become "<owner>.<key>". */
	addCsv(csv: string, owner: string): void;
	/** Add or replace texts of any plugin by full key ("<pluginId>.<key>") and locale (columns key, then locales). */
	inject(csv: string): void;
	/**
	 * The full key of a text of the plugin whose setup is running (e.g. a building's name given to the
	 * buildings plugin by a content plugin); already full keys stay as they are.
	 */
	own(text: string): string;
	/**
	 * `own` for later: called in a setup, the function it returns makes full keys of that plugin's texts at
	 * any time (e.g. names a content plugin's tables produce at runtime).
	 */
	scope(): (text: string) => string;
	/** Whether a string is a registered full key ("starter-content.Farm"), e.g. a settlement's default name. */
	isKey(text: string): boolean;
	/**
	 * A content name made of others ("Key to {0}" with a realm's name), as a key of the plugin whose setup is
	 * running: "<pluginId>.<key>", translated in every locale from its parts' translations. So a composed name
	 * is a key like any other (one string, wherever names go).
	 */
	derive(key: string, text: UiText): string;
}

declare module '../../kernel' {
	interface ServiceMap {
		i18n: I18nService;
	}
}

export default definePlugin({
	id: 'i18n',
	version: '0.2.0',
	description: 'Translations of every plugin, namespaced by plugin, with a slot for injected translations',
	setup(ctx) {
		const own: Record<string, Record<string, string>> = {};
		const injected: Record<string, Record<string, string>> = {};
		const keys = new Set<string>();
		const derived = new Map<string, UiText>();
		const service: I18nService = {
			addCsv(csv, owner) {
				const rows = csvRows(csv);
				if (rows.length && !('en' in rows[0])) throw new PluginError(`i18n of "${owner}": columns must be key, en, then locales`);
				const seen = new Set<string>();
				for (const r of rows) {
					if (!r.key) continue;
					if (seen.has(r.key)) throw new PluginError(`i18n of "${owner}": key "${r.key}" twice`);
					seen.add(r.key);
					keys.add(`${owner}.${r.key}`);
					if (!r.en) throw new PluginError(`i18n of "${owner}": key "${r.key}" has no English`);
					for (const [locale, text] of Object.entries(r)) if (locale !== 'key' && text) (own[locale] ??= {})[`${owner}.${r.key}`] = text;
				}
			},
			inject(csv) {
				for (const r of csvRows(csv)) {
					if (!r.key) continue;
					for (const [locale, text] of Object.entries(r)) {
						if (locale === 'key' || !text) continue;
						const into = (injected[locale] ??= {});
						if (r.key in into && into[r.key] !== text)
							throw new PluginError(`i18n injections disagree on ${locale} "${r.key}": "${into[r.key]}" and "${text}"`);
						into[r.key] = text;
					}
				}
			},
			own(text) {
				if (service.isKey(text)) return text;
				const caller = ctx.caller();
				if (!caller) throw new PluginError(`i18n.own("${text}") outside a plugin's setup`);
				return `${caller}.${text}`;
			},
			scope() {
				const caller = ctx.caller();
				if (!caller) throw new PluginError("i18n.scope() outside a plugin's setup");
				return (text) => (service.isKey(text) ? text : `${caller}.${text}`);
			},
			isKey: (text) => keys.has(text),
			derive(key, text) {
				const caller = ctx.caller();
				if (!caller) throw new PluginError(`i18n.derive("${key}") outside a plugin's setup`);
				const full = `${caller}.${key}`;
				if (keys.has(full)) throw new PluginError(`i18n of "${caller}": key "${key}" twice`);
				keys.add(full);
				derived.set(full, text);
				return full;
			},
		};
		ctx.services.provide('i18n', service);
		service.addCsv(i18nCsv, ctx.pluginId);
		// The kernel is no plugin: its messages are registered here, as "kernel.<key>".
		service.addCsv(kernelCsv, 'kernel');
		// Injected texts win over the plugin's own (a community translation may correct one). Derived names are
		// filled in from those, per locale (English where a part has no translation).
		ctx.meta.add('i18n', () => {
			const tables = Object.fromEntries(
				[...new Set([...Object.keys(own), ...Object.keys(injected)])].map((locale) => [locale, { ...own[locale], ...injected[locale] }]),
			);
			const render = (t: UiText, locale: string): string => {
				const template = tables[locale]?.[t.text] ?? tables.en?.[t.text] ?? t.text;
				return template.replace(/\{(\w+)\}/g, (all, k: string) => {
					const v = t.vars?.[k];
					if (v === undefined) return all;
					if (Array.isArray(v)) return v.map((x) => render(x, locale)).join(', ');
					return typeof v === 'object' ? render(v, locale) : String(v);
				});
			};
			for (const [key, text] of derived)
				for (const locale of Object.keys(tables)) if (tables[locale][text.text] !== undefined) tables[locale][key] = render(text, locale);
			return tables;
		});
	},
});
