// The troops' screens made here from the server's data: the Army page's garrisons (./garrisons.ts) and each barracks'
// training queue on its entry (./training.ts); the words of its forms (./forms.ts); what its commands did, in the data
// held here (./patches.ts).
import type { GarrisonInfo, TroopsState, UnitCatalog } from '../../../src/shared/api';
import { garrisonMoved, stateMoved } from '../../../src/shared/troops';
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import { stateTraining, withoutPlan } from './patches';
import { views } from './views';

export default defineClientPlugin({
	id: 'troops',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		for (const p of formParts) game.clientPart(p);
		// Dismissed: gone from the garrisons held (the Army page, every barracks' entry), upkeep with them.
		game.afterCommand('troops.dismiss', (_type, payload) => {
			const { settlement, unit, count } = payload as { settlement: string; unit: string; count: number };
			const moved = { [unit]: Number(count) };
			const catalog = game.static<UnitCatalog>('troops.units');
			game.patchView<TroopsState>('troops.state', (s) => stateMoved(s, settlement, moved, catalog));
			game.patchView<GarrisonInfo | null>('troops.garrison', (g) => garrisonMoved(g, settlement, moved, catalog));
		});
		// Trained or a plan cancelled: when it starts and ends only the server knows (the queue, the modifiers); its answer
		// brings the barracks' garrison (the entry the form is on), whose training then shows on the Army page too.
		const training = (type: string) => type === 'troops.train' || type === 'troops.cancel';
		let sent = 0;
		game.afterCommand(training, (type, payload) => {
			sent = Date.now();
			if (type === 'troops.cancel') {
				const { id } = payload as { id: string };
				game.patchView<GarrisonInfo | null>('troops.garrison', (g) => withoutPlan(g, id));
			}
		});
		game.afterCommand(
			training,
			(_type, payload) => {
				const { settlement } = payload as { settlement: string };
				const fresh = game
					.held<GarrisonInfo | null>('troops.garrison')
					.filter((h) => h.value?.settlement === settlement && h.at >= sent)
					.sort((a, b) => b.at - a.at)[0]?.value;
				if (fresh) game.patchView<TroopsState>('troops.state', (s) => stateTraining(s, fresh));
				else {
					// Sent from elsewhere (the assistant): asked again where they show next.
					game.markStale('troops.state');
					game.markStale('troops.garrison');
				}
			},
			{ answered: true },
		);
	},
});
