// The mail plugin's views assembled in the browser (src/shared/client-views.ts).
import type { MailNotice } from '../../../src/shared/api';
import { defineClientView } from '../../../src/shared/client-views';
import { announcementBanner } from './announcement';

export const views = [
	defineClientView({
		id: 'mail.announcement',
		needs: ['mail.notice'],
		compute: (get) => announcementBanner(get.data<MailNotice | null>('mail.notice')),
	}),
];
