// Generic forms: renders forms that server plugins attach to commands (view `ui.forms`),
// so simple features need no frontend code. Other plugins place a <FormOutlet> wherever
// a placement belongs, e.g. the city page shows placement "settlement".
import type { Component } from 'vue';
import type { FormPatches, ResolvedForm } from '../../../src/shared/api';
import { resolveForms } from '../../../src/shared/forms';
import { defineClientPlugin } from '../../core/game';
import DynamicForm from './DynamicForm.vue';
import EntryForms from './EntryForms.vue';
import FormOutlet from './FormOutlet.vue';
import { views } from './views';
import { widgets, type FormWidget } from './widgets';

export interface FormsService {
	/** <FormOutlet placement="..." :context="{ x: '1' }" :only="['cmd']" /> — context is added to the current game params; `only` keeps those commands' forms. */
	Outlet: Component;
	/** A single form: <Form :form="resolvedForm" :submit="optional override" />. */
	Form: Component;
	/** Editor for fields of type 'widget' whose `widget` is `name`. */
	widget(name: string, widget: FormWidget): void;
	/** Forms as shown from `forms.patches` fetched elsewhere (e.g. the GM console's, for another player). */
	resolve(patches: FormPatches): ResolvedForm[];
}

declare module '../../core/game' {
	interface ClientServiceMap {
		forms: FormsService;
	}
}

export default defineClientPlugin({
	id: 'forms',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		game.messages('zh-CN', {
			Submit: '提交',
			'Working…': '处理中…',
			'{label}: {used} / {total}': '{label}：{used} / {total}',
			'over the limit': '超出上限',
		});
		game.provide('forms', {
			Outlet: FormOutlet,
			Form: DynamicForm,
			resolve: (patches) =>
				resolveForms(
					{
						static: game.static,
						meta: ((key: string) => (game.meta as unknown as Record<string, unknown>)[key]) as never,
						parts: game.parts,
					},
					patches,
				) ?? [],
			widget(name, widget) {
				if (widgets.has(name)) throw new Error(`Form widget "${name}" registered twice`);
				widgets.set(name, widget);
			},
		});
		// Where they go is declared by the server (meta `ui`).
		// Global actions (e.g. "found your capital") at the top of the left column of every page.
		game.widget('forms.outlet', FormOutlet);
		// Server forms with placement "building" appear on building entries, below the building's own block.
		game.widget('forms.entry', EntryForms);
	},
});
