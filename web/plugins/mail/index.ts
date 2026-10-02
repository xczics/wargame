// Mailbox: a Mail page (messages on the left, the open one on the right) and an unread
// counter in the top band. What a message looks like is up to the plugin that sends its
// kind: its widget, mapped to the kind by the server (meta `ui.mail`).
import { defineClientPlugin } from '../../core/game';
import MailBadge from './MailBadge.vue';
import MailList from './MailList.vue';
import MailView from './MailView.vue';
import { selected } from './state';

export interface MailService {
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
			Newer: '较新',
			Older: '更早',
			'Page {n}': '第 {n} 页',
			'{n} unread': '{n} 封未读',
		});
		game.need('mail.inbox');
		game.provide('mail', {
			open(id) {
				if (id) selected.value = id;
				game.showPage('mail');
			},
		});
		// Where they go is declared by the server (meta `ui`).
		game.widget('mail.list', MailList);
		game.widget('mail.view', MailView);
		game.widget('mail.badge', MailBadge);
	},
});
