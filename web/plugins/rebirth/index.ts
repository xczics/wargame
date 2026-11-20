// Rebirth in the browser: the stars on hero cards and the rebirth pill's form (./parts.ts). A pill used: whether it
// took is rolled by the server, so the heroes (level, talent, points, the stars) and the pill's form ask again where
// they show next (the current page's come with the answer).
import { defineClientPlugin } from '../../core/game';
import { PILL } from '../../../src/shared/rebirth';
import { parts } from './parts';

export default defineClientPlugin({
	id: 'rebirth',
	dependsOn: ['heroes'],
	setup(game) {
		for (const p of parts) game.clientPart(p as never);
		game.afterCommand(`items.use.${PILL}`, () => {
			game.use('heroes').unknown();
			game.markStale('forms.patches');
		});
	},
});
