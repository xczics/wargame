// Generic forms: renders forms that server plugins attach to commands (view `ui.forms`),
// so simple features need no frontend code. Other plugins place a <FormOutlet> wherever
// a placement belongs, e.g. the city page shows placement "settlement".
import type { Component } from 'vue';
import { defineClientPlugin } from '../../core/game';
import DynamicForm from './DynamicForm.vue';
import FormOutlet from './FormOutlet.vue';

export interface FormsService {
	/** <FormOutlet placement="..." :context="{ x: '1' }" /> — context is added to the current game params. */
	Outlet: Component;
	/** A single form: <Form :form="resolvedForm" :submit="optional override" />. */
	Form: Component;
}

declare module '../../core/game' {
	interface ClientServiceMap {
		forms: FormsService;
	}
}

export default defineClientPlugin({
	id: 'forms',
	setup(game) {
		game.messages('zh-CN', { Submit: '提交' });
		game.provide('forms', { Outlet: FormOutlet, Form: DynamicForm });
		// Global actions (e.g. "found your capital") above everything else.
		game.slot('main', FormOutlet, { order: -100 });
	},
});
