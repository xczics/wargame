// The mail plugin's views assembled in the browser (src/shared/client-views.ts).
import type { MailNotice, MailReportPart } from '../../../src/shared/api';
import { defineClientPart, defineClientView } from '../../../src/shared/client-views';
import { literal } from '../../../src/shared/i18n';
import { announcementBanner } from './announcement';

export const views = [
	defineClientView({
		id: 'mail.announcement',
		needs: ['mail.notice'],
		compute: (get) => announcementBanner(get.data<MailNotice | null>('mail.notice')),
	}),
];

export const parts = [
	// The GM's mail to everyone: its body line by line, as the GM wrote it.
	defineClientPart<MailReportPart>({
		point: 'mail.report',
		id: 'mail.broadcast',
		part: (message) => ({
			lines: String((message.data as { body?: unknown } | null)?.body ?? '')
				.split('\n')
				.map((line) => ({ text: literal(line) })),
		}),
	}),
];
