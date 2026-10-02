/**
 * Translations that come with the server's plugins (docs/design/architecture.md §3.3): every plugin
 * ships the words of its own content and messages (`data/i18n.csv`: `key` = the English text the
 * client shows or receives, one column per locale, e.g. `zh-CN`), so new content needs no client
 * change. Served in meta `i18n` as { locale: { key: text } }. Keys may hold placeholders `{0}`, `{1}`
 * for server messages that embed values ("Requires {0} Lv {1}"); see web/core/i18n.ts.
 */
import { csvRows, definePlugin, PluginError } from '../../kernel';

export interface I18nService {
	/** Add translations; the same key with a different text for a locale is an error (two plugins disagree). */
	add(locale: string, messages: Record<string, string>): void;
	/** A table with column `key` and one column per locale; empty cells are skipped. */
	addCsv(csv: string): void;
}

declare module '../../kernel' {
	interface ServiceMap {
		i18n: I18nService;
	}
}

export default definePlugin({
	id: 'i18n',
	version: '0.1.0',
	description: 'Translations shipped by the server plugins, served to the client',
	setup(ctx) {
		const byLocale: Record<string, Record<string, string>> = {};
		const service: I18nService = {
			add(locale, messages) {
				const into = (byLocale[locale] ??= {});
				for (const [key, text] of Object.entries(messages)) {
					if (key in into && into[key] !== text) throw new PluginError(`i18n ${locale}: "${key}" is "${into[key]}" and "${text}"`);
					into[key] = text;
				}
			},
			addCsv(csv) {
				const rows = csvRows(csv);
				const locales = rows.length ? Object.keys(rows[0]).filter((k) => k !== 'key') : [];
				for (const locale of locales)
					service.add(locale, Object.fromEntries(rows.filter((r) => r.key && r[locale]).map((r) => [r.key, r[locale]])));
			},
		};
		ctx.services.provide('i18n', service);
		ctx.meta.add('i18n', () => byLocale);
	},
});
