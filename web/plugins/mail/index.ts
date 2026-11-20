// Mailbox: a Mail page (messages on the left, the open one on the right) and an unread
// counter in the top band. What a message looks like is up to the plugin that sends its
// kind: its widget, mapped to the kind by the server (meta `ui.mail`).
import type { MailInbox } from '../../../src/shared/api';
import { defineClientPlugin } from '../../core/game';
import MailBadge from './MailBadge.vue';
import MailList from './MailList.vue';
import MailView from './MailView.vue';
import { claimed } from './patches';
import { bodies, selected } from './state';
import { parts, views } from './views';

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
	// Claimed attachments are applied through its service.
	dependsOn: ['rewards'],
	setup(game) {
		game.messages('zh-CN', {
			Mail: '邮件',
			Mailbox: '邮箱',
			'No mail.': '没有邮件。',
			'Delete by kind…': '按类型批量删除…',
			'Sure? Delete them all': '确定？全部删除',
			'Deleting…': '删除中…',
			'Mark all read': '全部标为已读',
			Delete: '删除',
			'Delete this message?': '删除这封邮件？',
			'Pick a message on the left.': '在左侧选择一封邮件。',
			Newer: '较新',
			Older: '更早',
			'Page {n}': '第 {n} 页',
			'{n} unread': '{n} 封未读',
			'Loading…': '加载中…',
			Attachments: '附件',
			Claim: '领取',
			Claimed: '已领取',
			'Claiming…': '领取中…',
			'Attachments to claim': '有附件待领取',
			'Attachments claimed': '附件已领取',
		});
		// The unread count everywhere (the badge); the messages only where they are shown.
		game.need('mail.unread');
		game.needWhere('mail.inbox', { page: 'mail' });
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
		for (const v of views) game.clientView(v.id, v);
		for (const p of parts) game.clientPart(p);
		// Claimed (user 2026-11-20: "你告诉前端成功了，前端不就能更新了吗？"): the attachments are the player's in the data held
		// here, for every page that shows them, each by its kind (the rewards' parts); the message says so in every page of
		// the inbox held.
		game.afterCommand('mail.claim', (_type, payload) => {
			const { id } = payload as { id: string };
			const attachments = bodies.value[id]?.attachments;
			if (attachments?.length) game.use('rewards').given(attachments);
			game.patchView<MailInbox>('mail.inbox', (inbox) => claimed(inbox, id));
		});
	},
});
