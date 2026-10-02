/**
 * UI layout declared by the server (docs/design/ui.md §3): plugins say what is shown where —
 * pages, blocks in a page's columns, blocks on an entry (e.g. a building), items in the top / bottom
 * band, widgets in named slots of other widgets (e.g. next to the user name), and which widget shows a
 * kind of mail. The client only knows widgets by name (`game.widget(name, component)`) and lays them
 * out from meta `ui`; a widget the client does not have is skipped.
 *
 * Widget names are `<owner>.<name>` by convention. Declaring here does not depend on any game system.
 */
import { definePlugin, PluginError } from '../../kernel';
import type { UiLayout, UiProps } from '../../shared/api';
import i18nCsv from './data/i18n.csv?raw';

export interface UiService {
	/** A page: two columns filled by blocks, or (with `widget`) one widget taking the whole area. `tab: false`: no tab. */
	page(page: { id: string; label: string; order?: number; tab?: boolean; widget?: string; props?: UiProps }): void;
	/** A block in a column of a page (`page: '*'`: every two-column page). Lower `order` first. */
	block(block: { page: string; column: 'left' | 'right'; widget: string; order?: number; props?: UiProps }): void;
	/** A block on every open entry of `kind` (e.g. "building"), or only for some entry `types` (worked out when meta is read). */
	entry(entry: { kind: string; widget: string; order?: number; types?: string[] | (() => string[]); props?: UiProps }): void;
	/** An item in a fixed band. */
	band(band: { band: 'top' | 'bottom'; widget: string; order?: number; props?: UiProps }): void;
	/** A widget in a named slot that another widget renders (e.g. "user-actions"). */
	slot(slot: { slot: string; widget: string; order?: number; props?: UiProps }): void;
	/** Which widget shows mail of `kind`. */
	mail(kind: string, widget: string): void;
	/** Declarations that depend on content defined later (e.g. where items have shortcuts), worked out when meta is read. */
	dynamic(declare: () => Partial<Pick<UiLayout, 'blocks' | 'entries' | 'slots'>>): void;
}

declare module '../../kernel' {
	interface ServiceMap {
		ui: UiService;
	}
}

export default definePlugin({
	id: 'ui',
	version: '0.1.0',
	description: 'Server-declared UI layout: pages, blocks, entries, bands, slots, mail widgets',
	dependsOn: ['i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const pages: UiLayout['pages'] = [];
		const blocks: UiLayout['blocks'] = [];
		const entries: (Omit<UiLayout['entries'][number], 'types'> & { types?: string[] | (() => string[]) })[] = [];
		const bands: UiLayout['bands'] = [];
		const slots: UiLayout['slots'] = [];
		const mail: UiLayout['mail'] = {};
		const dynamic: (() => Partial<Pick<UiLayout, 'blocks' | 'entries' | 'slots'>>)[] = [];

		ctx.services.provide('ui', {
			page({ id, label: raw, order = 0, tab = true, widget, props }) {
				const label = ctx.services.get('i18n').own(raw);
				if (pages.some((p) => p.id === id)) throw new PluginError(`UI page "${id}" declared twice`);
				pages.push({ id, label, order, tab, ...(widget ? { widget } : {}), ...(props ? { props } : {}) });
			},
			block: ({ page, column, widget, order = 0, props }) => void blocks.push({ page, column, widget, order, ...(props ? { props } : {}) }),
			entry: ({ kind, widget, order = 0, types, props }) =>
				void entries.push({ kind, widget, order, ...(types ? { types } : {}), ...(props ? { props } : {}) }),
			band: ({ band, widget, order = 0, props }) => void bands.push({ band, widget, order, ...(props ? { props } : {}) }),
			slot: ({ slot, widget, order = 0, props }) => void slots.push({ slot, widget, order, ...(props ? { props } : {}) }),
			mail(kind, widget) {
				if (mail[kind]) throw new PluginError(`Mail widget for "${kind}" declared twice`);
				mail[kind] = widget;
			},
			dynamic: (declare) => void dynamic.push(declare),
		});

		ctx.meta.add('ui', (): UiLayout => {
			const more = dynamic.map((d) => d());
			return {
				pages,
				blocks: [...blocks, ...more.flatMap((m) => m.blocks ?? [])],
				entries: [
					...entries.map(({ types, ...e }) => ({ ...e, ...(types ? { types: typeof types === 'function' ? types() : types } : {}) })),
					...more.flatMap((m) => m.entries ?? []),
				],
				bands,
				slots: [...slots, ...more.flatMap((m) => m.slots ?? [])],
				mail,
			};
		});
	},
});
