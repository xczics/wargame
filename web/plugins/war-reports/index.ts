// War reports in the browser: the battle reports and troop notices in the mailbox, assembled from the mails' data and
// the battle the server attaches (./report.ts).
import { defineClientPlugin } from '../../core/game';
import { parts } from './views';

export default defineClientPlugin({
	id: 'war-reports',
	setup(game) {
		for (const p of parts) game.clientPart(p);
	},
});
