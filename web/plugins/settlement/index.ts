// Which settlement the player is looking at. Provides the "settlement" service and a
// switcher at the top of the left column; the choice travels to the server as the `settlement` param.
import { computed, type ComputedRef, watch } from 'vue';
import type { SettlementSummary } from '../../../src/shared/api';
import { defineClientPlugin } from '../../core/game';
import SettlementSwitcher from './SettlementSwitcher.vue';

export interface SettlementService {
	list: ComputedRef<SettlementSummary[]>;
	/** The selected settlement (default: the capital). */
	current: ComputedRef<SettlementSummary | null>;
	select(id: string): Promise<void>;
	kindName(kind: string): string;
}

declare module '../../core/game' {
	interface ClientServiceMap {
		settlement: SettlementService;
	}
}

export default defineClientPlugin({
	id: 'settlement',
	dependsOn: ['auth'],
	setup(game) {
		game.need('settlements.mine');
		const list = computed(() => game.view('settlements.mine') ?? []);
		const current = computed(
			() =>
				list.value.find((s) => s.id === game.params.settlement) ?? list.value.find((s) => s.kind === 'capital') ?? list.value[0] ?? null,
		);
		const kinds = new Map((game.meta.settlementKinds ?? []).map((k) => [k.id, k.name]));
		game.provide('settlement', {
			list,
			current,
			select: (id) => game.setParam('settlement', id),
			kindName: (kind) => game.t(kinds.get(kind) ?? kind),
		});
		game.widget('settlement.switcher', SettlementSwitcher);
		// An open entry (e.g. a building) belongs to the settlement it was opened in.
		watch(
			() => current.value?.id,
			(id) => game.entry.value?.data?.settlement && game.entry.value.data.settlement !== id && game.openEntry(null),
		);
	},
});
