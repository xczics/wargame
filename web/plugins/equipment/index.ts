// Equipment in the browser: the gear rows and the paper doll worked out from the settlement's gear data (the server
// sends data only; the widgets and their places are declared by the server plugin). The doll's art comes from a content
// plugin through the `equipment` service (`setArt`); without one the doll shows the frames only. The same art draws the
// equipment's icons everywhere else (art icon scheme "equipment", src/shared/equipment.ts: ./PieceIcon.vue).
import { shallowRef, type ShallowRef } from 'vue';
import type { EquipmentCreated, EquipmentItems, EquipmentTotals, HeroInfo } from '../../../src/shared/api';
import { EQUIPMENT_ICON } from '../../../src/shared/equipment';
import { ICON_POINT } from '../../../src/shared/icons';
import { defineClientPlugin } from '../../core/game';
import type { DollArt } from './art';
import Doll from './Doll.vue';
import { created, equip, heroMoved, heroRenamed, smelted, smeltMatch, totalsWith, unequip } from './patch';
import PieceIcon from './PieceIcon.vue';
import { parts, views } from './views';

export interface EquipmentClientService {
	art: ShallowRef<DollArt | null>;
	setArt(art: DollArt): void;
	/**
	 * How many of a group's pieces a hero may wear (the server's `setGroupLimit`, e.g. "accessory"), for a hero the browser
	 * made itself (a recruit); undefined: not known yet (asked for again). None set: 0, as on the server.
	 */
	setGroupLimit(group: string, limit: (hero: Omit<HeroInfo, 'bonus'>) => number | undefined): void;
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
		const limits = new Map<string, (hero: Omit<HeroInfo, 'bonus'>) => number | undefined>();
		game.provide('equipment', { art, setArt: (a) => (art.value = a), setGroupLimit: (g, l) => void limits.set(g, l) });
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
			// (The forms that count the gear, bulk smelting and spending points, are old after any command: web/core/game.ts.)
			if (changed.length) game.patchView<EquipmentTotals>('equipment.totals', (t) => changed.reduce(totalsWith, t));
		};
		const p = (payload: unknown) => (payload ?? {}) as Record<string, string | undefined>;
		game.afterCommand('equipment.equip', (_t, payload) => change((items) => equip(items, p(payload).piece!, p(payload).hero!, bases())));
		game.afterCommand('equipment.unequip', (_t, payload) => change((items) => unequip(items, p(payload).piece!)));
		game.afterCommand('equipment.smelt', (_t, payload) => change((items) => smelted(items, (x) => x.id === p(payload).piece)));
		game.afterCommand('equipment.smeltMany', (_t, payload) => {
			const match = smeltMatch(p(payload) as { settlement: string }, bases());
			change((items) => smelted(items, match(items)));
		});

		// Pieces a command made (bought, a chest, a reward, a drop): the answer says them whole ("equipment.created"), into the
		// storage rows of their settlement.
		game.afterCommand(
			() => true,
			(_t, _p, reply) => {
				const made = (reply['equipment.created'] ?? []) as EquipmentCreated[];
				if (made.length) game.patchView<EquipmentItems>('equipment.items', (items) => created(items, made));
			},
		);

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
			added(h) {
				// Recruited (or given): a row in its settlement's gear, with how many accessories it may wear by the content's
				// rule (`setGroupLimit`).
				const accessories = limits.has('accessory') ? limits.get('accessory')!(h) : 0;
				if (accessories === undefined) return game.markStale('equipment.items');
				game.patchView<EquipmentItems>('equipment.items', (items) =>
					items.settlement !== h.home || items.heroes.some((x) => x.id === h.id)
						? items
						: {
								...items,
								heroes: [...items.heroes, { id: h.id, surname: h.surname, given: h.given, level: h.level, gender: h.gender, accessories }],
							},
				);
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
