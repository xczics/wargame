// The Army page's incoming attacks and marches, assembled in the browser from the armies plugin's data (./timers.ts),
// the marches settled when sent played out (./staged.ts) and the words of its forms (./forms.ts).
import { shallowRef, watch } from 'vue';
import type { ArmyMarch, GarrisonInfo, ResourcePool, StagedMarch, TroopsState } from '../../../src/shared/api';
import { defineClientPlugin } from '../../core/game';
import { formParts } from './forms';
import { playing, stagedGarrison, stagedList, stagedPool, stagedTroops } from './staged';
import { views } from './views';

export default defineClientPlugin({
	id: 'armies',
	setup(game) {
		for (const v of views) game.clientView(v.id, v);
		for (const p of formParts) game.clientPart(p);
		// Only in a command's answer: kept here (memory only: after a reload they show as arrived, as the server has them).
		game.need('armies.staged');
		const staged = shallowRef<StagedMarch[]>([]);
		let over: ReturnType<typeof setTimeout> | undefined;
		watch(
			() => game.view('armies.staged'),
			(sent) => {
				if (!sent?.length) return;
				const now = game.serverNow();
				staged.value = [...playing(staged.value, now).filter((m) => !sent.some((x) => x.id === m.id)), ...sent];
				// Once the last is home, none is left: the displays stop reading the clock (2026-10-25: they went on ticking
				// ten times a second for the rest of the session). One timer, at the latest return.
				clearTimeout(over);
				const last = Math.max(...staged.value.map((m) => m.returnsAt));
				over = setTimeout(() => (staged.value = playing(staged.value, game.serverNow())), Math.max(0, last - now) + 100);
			},
		);
		/** The staged marches, with the clock read only while there are some (so displays do not tick for nothing). */
		const at = () => (staged.value.length ? { list: staged.value, now: game.serverNow() } : null);
		game.adjust<ResourcePool>('resources.pool', (pool) => {
			const s = at();
			return s ? stagedPool(pool, s.list, s.now) : pool;
		});
		game.adjust<GarrisonInfo>('troops.garrison', (g) => {
			const s = at();
			return s ? stagedGarrison(g, s.list, s.now) : g;
		});
		game.adjust<TroopsState>('troops.state', (state) => {
			const s = at();
			return s ? stagedTroops(state, s.list, s.now) : state;
		});
		game.adjust<ArmyMarch[]>('armies.list', (list) => {
			const s = at();
			return s ? stagedList(list, s.list, s.now) : list;
		});
	},
});
