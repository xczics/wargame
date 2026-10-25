/**
 * The art icon of an equipment piece (scheme "equipment", src/shared/icons.ts): its set, slot and colour, drawn by the
 * equipment client plugin from whatever art pack a content plugin gave it (`equipment.setArt`), else the fallback emoji.
 * Pure: both ends use it.
 */
import { artIcon, parseIcon } from './icons';

export const EQUIPMENT_ICON = 'equipment';

/** "art:equipment:<set>/<slot>/<rarity>|<fallback>". */
export const equipmentIcon = (p: { set?: string; slot: string; rarity: string }, fallback = ''): string =>
	artIcon(EQUIPMENT_ICON, `${p.set ?? ''}/${p.slot}/${p.rarity}`, fallback);

/** A piece's set, slot and colour from its icon key (the part after "art:equipment:"). */
export function equipmentIconKey(key: string): { set?: string; slot: string; rarity: string } | null {
	const [set, slot, rarity, ...rest] = key.split('/');
	if (!slot || !rarity || rest.length) return null;
	return { ...(set ? { set } : {}), slot, rarity };
}

/** The same for a whole icon (null: not an equipment icon). */
export function parseEquipmentIcon(icon: string | undefined): { set?: string; slot: string; rarity: string } | null {
	const a = parseIcon(icon);
	return a && a.scheme === EQUIPMENT_ICON ? equipmentIconKey(a.key) : null;
}

/** A hero's worn stats under `prefix` (e.g. "attr." to the attributes, "adv." to the adventure numbers), the prefix cut off. */
export function statsUnder(sums: Record<string, number> | undefined, prefix: string): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [k, v] of Object.entries(sums ?? {})) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
	return out;
}
