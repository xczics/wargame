// What the gear rows (./gear.ts) and the paper doll (./doll.ts) both say about a piece, from `equipment.state`. Pure.
import type { EquipmentState } from '../../../src/shared/api';
import { amount, amounts } from '../../../src/shared/format';
import { keyText, literal, uiTexts } from '../../../src/shared/i18n';
import type { UiAction, UiText } from '../../../src/shared/ui';

// The equipment plugin's own words (its i18n keys).
export const text = uiTexts('equipment');

export type Piece = EquipmentState['pieces'][number];

const FACET_LABEL = { rarity: 'Colour', set: 'Set', slot: 'Slot' } as const;

/** "Attack +12", one per stat. */
export const pieceStats = (p: Piece): UiText[] => p.stats.map((x) => text('{0} +{1}', { 0: keyText(x.name), 1: amount(x.value, 1) }));

export const takeOff = (p: Piece): UiAction => ({ command: 'equipment.unequip', payload: { piece: p.id }, label: text('Take off') });

/** Why the hero cannot wear it yet (null: it can, or no hero is chosen). */
export function tooLow(p: Piece, hero: { level: number } | undefined): UiText | null {
	return hero && p.minLevel && hero.level < p.minLevel ? text('Needs a hero of level {0}', { 0: p.minLevel }) : null;
}

/** A stored piece's buttons: wear it on the chosen hero (if any), dismantle it. */
export function storedActions(state: EquipmentState, p: Piece, hero: { id: string; level: number } | undefined): UiAction[] {
	const low = tooLow(p, hero);
	return [
		...(hero
			? [{ command: 'equipment.equip', payload: { piece: p.id, hero: hero.id }, label: text('Wear'), ...(low ? { blocked: low } : {}) }]
			: []),
		{
			command: 'equipment.smelt',
			payload: { piece: p.id },
			label: text('Dismantle ({0})', { 0: amounts(state.smelt[p.id] ?? {}, state.icons) }),
			confirm: text('Dismantle this piece?'),
		},
	];
}

/** "Smelt in bulk" on the storage (two or more stored). */
export const smeltBulk = (state: EquipmentState, stored: number): UiAction[] =>
	stored > 1
		? [
				{
					entry: { kind: 'equipment-smelt', id: state.settlement, label: text('Smelt in bulk'), data: { settlement: state.settlement } },
					label: text('Smelt in bulk'),
				},
			]
		: [];

export const facetsOf = (p: Piece) => ({ rarity: p.rarity, set: p.set?.id ?? '', slot: p.slot });

/**
 * The storage filters: the colours, sets and slots the stored pieces have (none other offered), as smelting in bulk
 * offers them (user 2026-10-19: "筛选功能不止用于拆解，也用于减小列表长度"). Only with two or more stored.
 */
export function storageFacets(state: EquipmentState, loose: Piece[]) {
	if (loose.length < 2) return undefined;
	const used = (key: 'rarity' | 'set' | 'slot') => new Set(loose.map((p) => facetsOf(p)[key]));
	const sets = new Map(loose.flatMap((p) => (p.set ? [[p.set.id, p.set.name] as const] : [])));
	const choices = {
		rarity: state.rarities.filter((r) => used('rarity').has(r.id)).map((r) => ({ value: r.id, label: keyText(r.name) })),
		set: [...used('set')].filter(Boolean).map((id) => ({ value: id, label: sets.has(id) ? keyText(sets.get(id)!) : literal(id) })),
		slot: state.slots.filter((x) => used('slot').has(x.id)).map((x) => ({ value: x.id, label: keyText(x.name) })),
	};
	return (['rarity', 'set', 'slot'] as const)
		.map((id) => ({ id, label: text(FACET_LABEL[id]), options: [{ value: '', label: text('Any') }, ...choices[id]] }))
		.filter((f) => f.options.length > 2);
}
