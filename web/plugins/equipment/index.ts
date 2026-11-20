// Equipment in the browser: the gear rows and the paper doll worked out from the settlement's gear data (the server
// sends data only; the widgets and their places are declared by the server plugin). The doll's art comes from a content
// plugin through the `equipment` service (`setArt`); without one the doll shows the frames only. The same art draws the
// equipment's icons everywhere else (art icon scheme "equipment", src/shared/equipment.ts: ./PieceIcon.vue).
import { shallowRef, type ShallowRef } from 'vue';
import type { EquipmentItems, EquipmentTotals } from '../../../src/shared/api';
import { EQUIPMENT_ICON } from '../../../src/shared/equipment';
import { ICON_POINT } from '../../../src/shared/icons';
import { defineClientPlugin } from '../../core/game';
import type { DollArt } from './art';
import Doll from './Doll.vue';
import { equip, heroMoved, heroRenamed, smelted, smeltMatch, totalsWith, unequip } from './patch';
import PieceIcon from './PieceIcon.vue';
import { parts, views } from './views';

export interface EquipmentClientService {
	art: ShallowRef<DollArt | null>;
	setArt(art: DollArt): void;
}

declare module '../../core/game' {
	interface ClientServiceMap {
		equipment: EquipmentClientService;
	}
}

export default defineClientPlugin({
	id: 'equipment',
	dependsOn: ['heroes'],
	setup(game) {
		game.messages('zh-CN', {
			'Needs level {0}': '需要 {0} 级',
			'Empty slot': '空位',
			Stored: '存放',
			Worn: '已穿戴',
		});
		const art = shallowRef<DollArt | null>(null);
		game.provide('equipment', { art, setArt: (a) => (art.value = a) });
		game.widget('equipment.doll', Doll);
		game.clientPart({ point: ICON_POINT, id: EQUIPMENT_ICON, part: PieceIcon });
		for (const v of views) game.clientView(v.id, v);
		for (const p of parts) game.clientPart(p);

		// What the gear commands did, in the gear held here at once (user 2026-11-20: "你告诉前端成功了，前端不就能更新了吗？"):
		// the rows of every settlement held, and the heroes' sums (their cards, adventure numbers and posts read those).
		const bases = () => game.meta.equipment?.bases ?? [];
		/** Change the rows held, then the sums of the heroes of the rows that changed. */
		const change = (fn: (items: EquipmentItems) => EquipmentItems) => {
			const changed: EquipmentItems[] = [];
			game.patchView<EquipmentItems>('equipment.items', (items) => {
				const next = fn(items);
				if (next !== items) changed.push(next);
				return next;
			});
			if (changed.length) game.patchView<EquipmentTotals>('equipment.totals', (t) => changed.reduce(totalsWith, t));
			// The forms that list what is stored here or count the gear (bulk smelting, spending points) ask again where
			// they show next.
			game.markStale('forms.patches');
		};
		const p = (payload: unknown) => (payload ?? {}) as Record<string, string | undefined>;
		game.afterCommand('equipment.equip', (_t, payload) => change((items) => equip(items, p(payload).piece!, p(payload).hero!, bases())));
		game.afterCommand('equipment.unequip', (_t, payload) => change((items) => unequip(items, p(payload).piece!)));
		game.afterCommand('equipment.smelt', (_t, payload) => change((items) => smelted(items, (x) => x.id === p(payload).piece)));
		game.afterCommand('equipment.smeltMany', (_t, payload) => {
			const match = smeltMatch(p(payload) as { settlement: string }, bases());
			change((items) => smelted(items, match(items)));
		});

		// The heroes as the gear rows show them follow what commands did to them.
		game.use('heroes').listen({
			changed(id, c) {
				if (c.level !== undefined || c.surname !== undefined || c.given !== undefined)
					game.patchView<EquipmentItems>('equipment.items', (items) => heroRenamed(items, id, c));
				if (!c.home) return;
				const home = c.home;
				const held = game.held<EquipmentItems | null>('equipment.items').map((x) => x.value);
				const from = held.find((x) => x?.settlement !== home && x?.heroes.some((h) => h.id === id)) ?? undefined;
				game.patchView<EquipmentItems>('equipment.items', (items) => heroMoved(items, id, home, from));
				if (!from && held.some((x) => x?.settlement === home)) game.markStale('equipment.items');
			},
			removed(id) {
				// What it wore goes into the capital's storage (the server's way): those rows ask again.
				game.patchView<EquipmentItems>('equipment.items', (items) =>
					items.heroes.some((h) => h.id === id) ? { ...items, heroes: items.heroes.filter((h) => h.id !== id) } : items,
				);
				game.patchView<EquipmentTotals>('equipment.totals', (t) => {
					if (!(id in t)) return t;
					const { [id]: _, ...rest } = t;
					return rest;
				});
				game.markStale('equipment.items');
			},
			unknown: () => game.markStale('equipment.items'),
		});
	},
});
