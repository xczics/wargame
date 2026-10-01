// Mailbox: a Mail page (messages on the left, the open one on the right) and an unread
// counter in the top band. What a message looks like is up to the plugin that sends its
// kind: it registers a renderer through the "mail" service.
import type { Component } from 'vue';
import { defineClientPlugin } from '../../core/game';
import MailBadge from './MailBadge.vue';
import MailList from './MailList.vue';
import MailView from './MailView.vue';
import { renderers, selected } from './state';

export interface MailService {
	/** Render messages of `kind` with `component` (it receives the message as prop `message`). */
	renderer(kind: string, component: Component): void;
	/** Open the mailbox at a message (or just the mailbox). */
	open(id?: string): void;
}

declare module '../../core/game' {
	interface ClientServiceMap {
		mail: MailService;
	}
}

export default defineClientPlugin({
	id: 'mail',
	setup(game) {
		game.messages('zh-CN', {
			Mail: '邮件',
			Mailbox: '邮箱',
			'No mail.': '没有邮件。',
			'Mark all read': '全部标为已读',
			Delete: '删除',
			'Delete this message?': '删除这封邮件？',
			'Pick a message on the left.': '在左侧选择一封邮件。',
			'Older messages are not shown.': '更早的邮件未显示。',
			'{n} unread': '{n} 封未读',
		});
		game.need('mail.inbox');
		game.provide('mail', {
			renderer(kind, component) {
				if (renderers.has(kind)) throw new Error(`Mail renderer for "${kind}" registered twice`);
				renderers.set(kind, component);
			},
			open(id) {
				if (id) selected.value = id;
				game.showPage('mail');
			},
		});
		game.page('mail', 'Mail', { order: 9.5 });
		game.block('mail', 'left', MailList);
		game.block('mail', 'right', MailView);
		game.band('top', MailBadge, { order: -1 });
	},
});
