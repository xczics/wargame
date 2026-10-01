// Generic forms: renders forms that server plugins attach to commands (view `ui.forms`),
// so simple features need no frontend code. Other plugins place a <FormOutlet> wherever
// a placement belongs, e.g. the city page shows placement "settlement".
import type { Component } from 'vue';
import { defineClientPlugin, EVERY_PAGE } from '../../core/game';
import DynamicForm from './DynamicForm.vue';
import EntryForms from './EntryForms.vue';
import FormOutlet from './FormOutlet.vue';
import { widgets, type FormWidget } from './widgets';

export interface FormsService {
	/** <FormOutlet placement="..." :context="{ x: '1' }" /> — context is added to the current game params. */
	Outlet: Component;
	/** A single form: <Form :form="resolvedForm" :submit="optional override" />. */
	Form: Component;
	/** Editor for fields of type 'widget' whose `widget` is `name`. */
	widget(name: string, widget: FormWidget): void;
}

declare module '../../core/game' {
	interface ClientServiceMap {
		forms: FormsService;
	}
}

export default defineClientPlugin({
	id: 'forms',
	setup(game) {
		game.messages('zh-CN', { Submit: '提交', '{label}: {used} / {total}': '{label}：{used} / {total}', 'over the limit': '超出上限' });
		game.provide('forms', {
			Outlet: FormOutlet,
			Form: DynamicForm,
			widget(name, widget) {
				if (widgets.has(name)) throw new Error(`Form widget "${name}" registered twice`);
				widgets.set(name, widget);
			},
		});
		// Global actions (e.g. "found your capital") at the top of the left column of every page.
		game.block(EVERY_PAGE, 'left', FormOutlet, { order: -90 });
		// Server forms with placement "building" appear on building entries, below the building's own block.
		game.entryBlock('building', EntryForms);
	},
});
