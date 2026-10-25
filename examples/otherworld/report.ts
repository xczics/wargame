// The otherworld example's scouting mail as a generic report (the server sends data only): a part at the mailbox's
// extension point "mail.report" for its kind. Pure, no client framework: the tests run it too.
import type { MailReportPart } from '../../src/shared/api';
import { defineClientPart } from '../../src/shared/client-views';
import { keyText, uiTexts } from '../../src/shared/i18n';

const text = uiTexts('otherworld');

/** "👹 Mountain demon at (4, 4)": who was found where. */
export const scouted = defineClientPart<MailReportPart>({
	point: 'mail.report',
	id: 'otherworld.scouted',
	part: (message) => {
		const { x, y, icon, name } = message.data as { x: number; y: number; icon: string; name: string };
		return {
			tone: 'bad',
			lines: [{ text: text('{0} {1} at ({2}, {3})', { 0: icon, 1: keyText(name), 2: x, 3: y }) }],
			notes: [{ text: text('It does not look friendly.'), tone: 'muted' }],
		};
	},
});
