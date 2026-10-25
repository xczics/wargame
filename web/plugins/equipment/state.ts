// A settlement's gear as the equipment screens use it, assembled in the browser from the rows the server forwards
// (`equipment.items`), the names in meta and the dismantling yields of the static `equipment.smelt`. Pure: the tests run it.
import type { EquipmentItems, EquipmentSmelt, EquipmentState, Meta } from '../../../src/shared/api';
import { resourceIcons } from '../../../src/shared/format';

/** The chosen hero (`hero`, else the first attached here): what it wears, then what is stored here. */
export function equipmentState(
	items: EquipmentItems | null | undefined,
	hero: string | undefined,
	meta: { equipment?: Meta['equipment']; heroes?: Meta['heroes']; resources?: Meta['resources'] },
	smelt: EquipmentSmelt | undefined,
): EquipmentState | null | undefined {
	if (items === null) return null;
	if (!items || !meta.equipment) return undefined;
	const bases = new Map(meta.equipment.bases.map((b) => [b.id, b]));
	const attrs = new Map((meta.heroes?.attributes ?? []).map((a) => [a.id, a.name]));
	const icon = resourceIcons(meta.resources ?? []);
	const piece = (p: EquipmentItems['pieces'][number]): EquipmentState['pieces'][number] => {
		const b = bases.get(p.base);
		return {
			id: p.id,
			name: b?.name ?? p.base,
			...(b?.icon ? { icon: b.icon } : {}),
			slot: b?.slot ?? '',
			rarity: p.rarity,
			stats: Object.entries(p.stats).map(([k, value]) => ({
				name: k.startsWith('attr.') ? (attrs.get(k.slice(5)) ?? k) : `${b?.labels ?? ''}${k}`,
				value,
			})),
			hero: p.hero,
			...(b?.minLevel ? { minLevel: b.minLevel } : {}),
			...(b?.set ? { set: b.set } : {}),
		};
	};
	const chosen = items.heroes.find((h) => h.id === hero) ?? items.heroes[0];
	const loose = items.pieces.filter((p) => !p.hero);
	const yields: EquipmentState['smelt'] = {};
	const icons: Record<string, string> = {};
	for (const p of loose) {
		yields[p.id] = smelt?.[`${p.base}|${p.rarity}`] ?? {};
		for (const r of Object.keys(yields[p.id])) icons[r] = icon[r] ?? r;
	}
	return {
		settlement: items.settlement,
		heroes: items.heroes.map(({ accessories: _, ...h }) => h),
		hero: chosen?.id ?? null,
		accessories: chosen?.accessories ?? 0,
		slots: meta.equipment.slots.map((x) => ({ id: x.id, name: x.name, ...(x.group ? { group: x.group } : {}) })),
		rarities: meta.equipment.rarities.map((r) => ({ id: r.id, name: r.name })),
		pieces: [...(chosen ? items.pieces.filter((p) => p.hero === chosen.id) : []), ...loose].map(piece),
		storage: { used: loose.length, capacity: items.capacity },
		smelt: yields,
		icons,
	};
}
