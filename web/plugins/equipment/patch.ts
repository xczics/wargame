// What the equipment commands did, told to the gear held here (every settlement's `equipment.items`, the heroes' sums
// `equipment.totals`) the way the server changes it (user 2026-11-20: "你告诉前端成功了，前端不就能更新了吗？"): the
// hero cards, the realms' adventure numbers and the posts follow the sums at once. Pure: the tests run them; ./index.ts
// applies them with `game.patchView`.
import type { EquipmentItems, EquipmentTotals, Meta } from '../../../src/shared/api';

type Bases = NonNullable<Meta['equipment']>['bases'];
type Piece = EquipmentItems['pieces'][number];

const slotOf = (bases: Bases, base: string) => bases.find((b) => b.id === base)?.slot;

/** On a hero (`equipment.equip`): from storage or another hero here; what it wore in that slot goes into storage. */
export function equip(items: EquipmentItems, piece: string, hero: string, bases: Bases): EquipmentItems {
	const p = items.pieces.find((x) => x.id === piece);
	if (!p || !items.heroes.some((h) => h.id === hero)) return items;
	const slot = slotOf(bases, p.base);
	return {
		...items,
		pieces: items.pieces.map((x) =>
			x.id === piece ? { ...x, hero } : x.hero === hero && slot !== undefined && slotOf(bases, x.base) === slot ? { ...x, hero: null } : x,
		),
	};
}

/** Off its hero, into the storage of the hero's settlement (`equipment.unequip`). */
export const unequip = (items: EquipmentItems, piece: string): EquipmentItems =>
	items.pieces.some((x) => x.id === piece && x.hero)
		? { ...items, pieces: items.pieces.map((x) => (x.id === piece ? { ...x, hero: null } : x)) }
		: items;

/** Stored pieces gone (`equipment.smelt`, `equipment.smeltMany`). */
export function smelted(items: EquipmentItems, gone: (p: Piece) => boolean): EquipmentItems {
	const left = items.pieces.filter((p) => p.hero || !gone(p));
	return left.length === items.pieces.length ? items : { ...items, pieces: left };
}

/** What `equipment.smeltMany` takes: the stored pieces of the settlement matching (none given, or "": any). */
export function smeltMatch(p: { settlement: string; rarity?: string; set?: string; slot?: string }, bases: Bases) {
	return (items: EquipmentItems) => (x: Piece) => {
		if (items.settlement !== p.settlement) return false;
		const b = bases.find((y) => y.id === x.base);
		return (!p.rarity || x.rarity === p.rarity) && (!p.set || (b?.set?.id ?? '') === p.set) && (!p.slot || b?.slot === p.slot);
	};
}

/** The sums of what the heroes of these gear rows wear, as the server keeps them (`equipment_totals`): by hero, by stat. */
export function totalsWith(totals: EquipmentTotals, items: EquipmentItems): EquipmentTotals {
	const out: EquipmentTotals = { ...totals };
	for (const h of items.heroes) delete out[h.id];
	for (const p of items.pieces) {
		if (!p.hero) continue;
		const sum = (out[p.hero] = { ...out[p.hero] });
		for (const [k, v] of Object.entries(p.stats)) sum[k] = (sum[k] ?? 0) + v;
	}
	return out;
}

/** A hero attached elsewhere (`heroes.setHome`): it and what it wears leave these rows, or come with `from` (its rows there). */
export function heroMoved(items: EquipmentItems, hero: string, home: string, from: EquipmentItems | undefined): EquipmentItems {
	if (items.settlement !== home) {
		if (!items.heroes.some((h) => h.id === hero)) return items;
		return { ...items, heroes: items.heroes.filter((h) => h.id !== hero), pieces: items.pieces.filter((p) => p.hero !== hero) };
	}
	const entry = from?.heroes.find((h) => h.id === hero);
	if (!entry || items.heroes.some((h) => h.id === hero)) return items;
	return { ...items, heroes: [...items.heroes, entry], pieces: [...items.pieces, ...from!.pieces.filter((p) => p.hero === hero)] };
}

/** A hero's level or name changed (what its rows show). */
export function heroRenamed(
	items: EquipmentItems,
	hero: string,
	change: { level?: number; surname?: string; given?: string },
): EquipmentItems {
	if (!items.heroes.some((h) => h.id === hero)) return items;
	const set = Object.fromEntries(Object.entries(change).filter(([k, v]) => v !== undefined && ['level', 'surname', 'given'].includes(k)));
	return { ...items, heroes: items.heroes.map((h) => (h.id === hero ? { ...h, ...set } : h)) };
}
