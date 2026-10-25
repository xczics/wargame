// Which settlement the player is looking at. Provides the "settlement" service and a
// switcher at the top of the left column; the choice travels to the server as the `settlement` param.
import { computed, type ComputedRef, watch } from 'vue';
import type { SettlementSummary } from '../../../src/shared/api';
import { defineClientPlugin } from '../../core/game';
import { mapPart } from './map';
import SettlementSwitcher from './SettlementSwitcher.vue';
import { formParts } from './forms';
import { views } from './views';

export interface SettlementService {
	list: ComputedRef<SettlementSummary[]>;
	/** The selected settlement (default: the capital). */
	current: ComputedRef<SettlementSummary | null>;
	select(id: string): Promise<void>;
	kindName(kind: string): string;
	/** One of the player's settlements by name (as renamed, else its kind's), else its id. */
	name(id: string): string;
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
		game.messages('zh-CN', { Settlement: '城池' });
		game.need('settlements.mine');
		const list = computed(() => game.view('settlements.mine') ?? []);
		// The one picked, else the capital (its kind says so in the meta), else the first.
		const capitalKind = (game.meta.settlementKinds ?? []).find((k) => k.capital)?.id;
		const current = computed(
			() =>
				list.value.find((s) => s.id === game.params.settlement) ?? list.value.find((s) => s.kind === capitalKind) ?? list.value[0] ?? null,
		);
		const kinds = new Map((game.meta.settlementKinds ?? []).map((k) => [k.id, k.name]));
		game.provide('settlement', {
			list,
			current,
			select: (id) => game.setParam('settlement', id),
			kindName: (kind) => game.t(kinds.get(kind) ?? kind),
			name: (id) => game.t(list.value.find((s) => s.id === id)?.name ?? id),
		});
		game.widget('settlement.switcher', SettlementSwitcher);
		for (const v of views) game.clientView(v.id, v);
		for (const p of formParts) game.clientPart(p);
		game.clientPart(mapPart);
		// The settlement shown, named in the syncs from the first one on (the server's default otherwise): views by
		// settlement then answer from their flat forms, which read by the settlement named (docs/development.md §2.3).
		watch(
			() => current.value?.id,
			(id) => void (id && !game.params.settlement && game.setParam('settlement', id, { refresh: false })),
			{ immediate: true },
		);
		// An open entry (e.g. a building) belongs to the settlement it was opened in.
		watch(
			() => current.value?.id,
			(id) => game.entry.value?.data?.settlement && game.entry.value.data.settlement !== id && game.openEntry(null),
		);
	},
});
