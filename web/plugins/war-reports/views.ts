// The war-reports plugin's parts in the browser: its mails as generic reports (./report.ts), at "mail.report" by kind.
import type { MailReportPart } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { defenseReport, marchReport, shortageReport } from './report';

export const parts = [
	// (`settlements.mine`: the player's settlements by name; synced on every page anyway.)
	defineClientPart<MailReportPart>({ point: 'mail.report', id: 'war-reports.march', needs: ['settlements.mine'], part: marchReport }),
	defineClientPart<MailReportPart>({ point: 'mail.report', id: 'war-reports.defense', needs: ['settlements.mine'], part: defenseReport }),
	defineClientPart<MailReportPart>({ point: 'mail.report', id: 'war-reports.shortage', needs: ['settlements.mine'], part: shortageReport }),
];
