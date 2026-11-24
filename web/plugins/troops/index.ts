// The troops' screens made here from the server's data: the Army page's garrisons (./garrisons.ts) and each barracks'
// training queue on its entry (./training.ts); the words of its forms (./forms.ts); what its commands did, in the data
// held here (./patches.ts).
import type { GarrisonInfo, TroopsState, UnitCatalog } from '../../../src/shared/api';
import { garrisonMoved, stateMoved } from '../../../src/shared/troops';
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import { garrisonTrained, type Queued, stateCancelled, stateTrained, withoutPlan } from './patches';
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
		// Trained: the batch into the garrisons held, its id and end (if it started) as the answer says ("troops.queued": the
		// queue and every modifier are the server's), its cost from the static numbers.
		game.afterCommand('troops.train', (_type, payload, reply, now) => {
			const p = payload as { settlement: string; unit: string; count: number };
			const order = { ...p, count: Number(p.count) };
			const q = reply['troops.queued'] as Queued | undefined;
			const unit = game.meta.units?.find((u) => u.id === p.unit);
			const cost = game.static<UnitCatalog>('troops.units')?.[p.unit]?.cost;
			if (!q || !unit || !cost) {
				game.markStale('troops.state');
				game.markStale('troops.garrison');
				return;
			}
			game.patchView<GarrisonInfo | null>('troops.garrison', (g) =>
				garrisonTrained(g, order, q, { now, line: unit.trainedAt ?? '', cost }),
			);
			game.patchView<TroopsState>('troops.state', (s) => stateTrained(s, order, q));
		});
		// A waiting plan cancelled: gone from both (its place in the garrison's training says which in the Army page's).
		game.afterCommand('troops.cancel', (_type, payload) => {
			const { settlement, id } = payload as { settlement: string; id: string };
			const g = game.held<GarrisonInfo | null>('troops.garrison').find((h) => h.value?.settlement === settlement)?.value;
			const index = g?.training.findIndex((b) => b.id === id) ?? -1;
			if (index >= 0) game.patchView<TroopsState>('troops.state', (s) => stateCancelled(s, settlement, index));
			else game.markStale('troops.state');
			game.patchView<GarrisonInfo | null>('troops.garrison', (x) => withoutPlan(x, id));
		});
	},
});
