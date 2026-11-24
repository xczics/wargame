// The troops' screens made here from the server's data: the Army page's garrisons (./garrisons.ts) and each barracks'
// training queue on its entry (./training.ts); the words of its forms (./forms.ts); what its commands did, in the data
// held here (./patches.ts).
import type { FormPatches, GarrisonInfo, TrainFormData, TroopsState, UnitCatalog } from '../../../src/shared/api';
import { garrisonMoved, stateMoved } from '../../../src/shared/troops';
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import { garrisonTrained, type Queued, stateCancelled, stateTrained, trainedEnd, withoutPlan } from './patches';
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
		// Trained: the batch into the garrisons held, its id as the answer says (made there), its end worked out here as the
		// queue does (user 2026-11-24: "训练完成时间……前端是知道的呀"): it starts now unless a batch of that building is
		// under way, for `batchSeconds` (the unit's seconds, the time factor the train form there holds, the static speed).
		game.afterCommand('troops.train', (_type, payload, reply, now) => {
			const p = payload as { settlement: string; unit: string; count: number };
			const order = { ...p, count: Number(p.count) };
			const id = (reply['troops.queued'] as { id?: string } | undefined)?.id;
			const unit = game.meta.units?.find((u) => u.id === p.unit);
			const stats = game.static<UnitCatalog>('troops.units')?.[p.unit];
			const speed = game.static<{ speed: number }>('troops.speed')?.speed;
			const form = game
				.held<FormPatches | null>('forms.patches')
				.flatMap((x) => x.value?.forms ?? [])
				.find(
					(f) =>
						f.command === 'troops.train' &&
						f.patch?.defaults?.settlement === p.settlement &&
						(f.patch.data?.['troops.train'] as TrainFormData | undefined)?.units.some((u) => u.unit === p.unit),
				);
			const data = form?.patch?.data?.['troops.train'] as TrainFormData | undefined;
			const garrison = game
				.held<GarrisonInfo | null>('troops.garrison')
				.map((x) => x.value)
				.find((g) => g?.settlement === p.settlement);
			if (!id || !unit || !stats || !speed || !data || !garrison) {
				game.markStale('troops.state');
				game.markStale('troops.garrison');
				return;
			}
			const line = unit.trainedAt ?? '';
			const factor = data.time.reduce((a, f) => a * f.factor, 1);
			const q: Queued = { id, finishesAt: trainedEnd(garrison, line, now, { base: stats.seconds, factor, speed, count: order.count }) };
			game.patchView<GarrisonInfo | null>('troops.garrison', (g) => garrisonTrained(g, order, q, { now, line, cost: stats.cost }));
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
