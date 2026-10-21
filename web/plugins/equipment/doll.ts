// The equipment screen as a paper doll (`equipment.doll`, widget `equipment.doll`), assembled in the browser (AGENTS.md:
// the server sends data only) from `equipment.state`. Pure: the tests run it. The chosen hero (figure by gender), what
// it wears in each regular slot, the heroine's accessory slots, and what the settlement stores.
import type { EquipmentDoll, EquipmentDollPiece, EquipmentState } from '../../../src/shared/api';
import { nameKey } from '../../../src/shared/heroes';
import { keyText } from '../../../src/shared/i18n';
import { facetsOf, type Piece, pieceStats, smeltBulk, storageFacets, storedActions, takeOff, text, tooLow } from './pieces';

export function dollData(state: EquipmentState | null | undefined): EquipmentDoll | null | undefined {
	if (!state) return state;
	const hero = state.heroes.find((h) => h.id === state.hero);
	const slotDefs = new Map(state.slots.map((x) => [x.id, x]));
	const rarityNames = new Map(state.rarities.map((r) => [r.id, r.name]));
	const describe = (p: Piece, actions: EquipmentDollPiece['actions']): EquipmentDollPiece => {
		const low = tooLow(p, hero);
		return {
			id: p.id,
			slot: p.slot,
			name: p.name,
			slotName: keyText(slotDefs.get(p.slot)?.name ?? p.slot),
			...(p.set ? { set: { id: p.set.id, name: keyText(p.set.name) } } : {}),
			rarity: p.rarity,
			rarityName: keyText(rarityNames.get(p.rarity) ?? p.rarity),
			stats: pieceStats(p),
			...(p.minLevel ? { minLevel: p.minLevel } : {}),
			...(low ? { tooLow: low } : {}),
			actions,
		};
	};
	const worn = hero ? state.pieces.filter((p) => p.hero === hero.id) : [];
	const bySlot = new Map(worn.map((p) => [p.slot, p]));
	const accessories = worn.filter((p) => slotDefs.get(p.slot)?.group === 'accessory');
	const loose = state.pieces.filter((p) => !p.hero);
	const facets = storageFacets(state, loose);
	return {
		title: text('Equipment'),
		...(hero
			? {
					picker: {
						param: 'hero',
						options: state.heroes.map((h) => ({ value: h.id, label: keyText(nameKey(h)) })),
						selected: hero.id,
					},
				}
			: {}),
		hero: hero ? { id: hero.id, gender: hero.gender, level: text('Lv {0}', { 0: hero.level }) } : null,
		slots: hero
			? state.slots
					.filter((x) => !x.group)
					.map((x) => {
						const p = bySlot.get(x.id);
						return { id: x.id, name: keyText(x.name), ...(p ? { piece: describe(p, [takeOff(p)]) } : {}) };
					})
			: [],
		accessories:
			hero && (state.accessories > 0 || accessories.length)
				? {
						title: text('Accessories ({0})', { 0: state.accessories }),
						limit: Math.max(state.accessories, accessories.length),
						worn: accessories.map((p) => describe(p, [takeOff(p)])),
						empty: text('Empty: wear one from the storage below'),
					}
				: null,
		storage: {
			title: text('Stored here {0} / {1}', { 0: state.storage.used, 1: state.storage.capacity }),
			pieces: loose.map((p) => ({ ...describe(p, storedActions(state, p, hero)), facets: facetsOf(p) })),
			actions: smeltBulk(state, loose.length),
			...(loose.length ? {} : { empty: text('Nothing stored here. Equipment drops in realms; an armory stores more.') }),
		},
		...(facets ? { facets } : {}),
	};
}
