// The selected settlement's gear rows (`equipment.gear`, generic `ui.rows`, shown on the armory's entry), assembled in
// the browser (AGENTS.md: the server sends data only) from `equipment.state`. Pure: the tests run it. What the chosen
// hero wears, accessory slots as a row of cells, and what the settlement stores. The heroes page shows the same as a
// paper doll (./doll.ts).
import type { EquipmentState } from '../../../src/shared/api';
import { nameKey } from '../../../src/shared/heroes';
import { keyText, literal } from '../../../src/shared/i18n';
import type { RowsData, UiCellItem, UiLine, UiRow } from '../../../src/shared/ui';
import { facetsOf, type Piece, pieceStats, smeltBulk, storageFacets, storedActions, takeOff, text, tooLow } from './pieces';

export function gearRows(state: EquipmentState | null | undefined): RowsData | null | undefined {
	if (!state) return state;
	const hero = state.heroes.find((h) => h.id === state.hero);
	const slotDefs = new Map(state.slots.map((x) => [x.id, x]));
	const statLine = (p: Piece): UiLine[] => (p.stats.length ? [{ text: text('{0}', { 0: pieceStats(p) }) }] : []);
	const sections: RowsData['sections'] = [];
	if (hero) {
		const worn = new Map(state.pieces.filter((p) => p.hero === hero.id).map((p) => [p.slot, p]));
		sections.push({
			rows: state.slots
				.filter((x) => !x.group)
				.map((x): UiRow => {
					const p = worn.get(x.id);
					return p
						? {
								id: x.id,
								icon: p.icon,
								title: keyText(p.name),
								rarity: p.rarity,
								badge: keyText(x.name),
								lines: statLine(p),
								actions: [takeOff(p)],
							}
						: { id: x.id, title: text('—'), badge: keyText(x.name) };
				}),
		});
		const limit = state.accessories;
		const on = state.pieces.filter((p) => p.hero === hero.id && slotDefs.get(p.slot)?.group === 'accessory');
		const cells = Array.from({ length: Math.max(limit, on.length) }, (_, i): UiCellItem => {
			const p = on[i];
			return p
				? {
						id: p.id,
						label: literal(p.icon ?? '◆'),
						// Name and stats in the cell itself (user 2026-10-05), the tooltip as well for narrow screens.
						sub: keyText(p.name),
						...(p.stats.length ? { note: text('{0}', { 0: pieceStats(p) }) } : {}),
						rarity: p.rarity,
						tone: 'solid',
						title: text('{0} · {1}', { 0: [keyText(p.name)], 1: pieceStats(p) }),
						action: takeOff(p),
					}
				: { id: `empty${i}`, label: text('＋'), title: text('Empty: wear one from the storage below') };
		});
		if (cells.length) sections.push({ title: text('Accessories ({0})', { 0: limit }), rows: [], cells });
	}
	const loose = state.pieces.filter((p) => !p.hero);
	const bulk = smeltBulk(state, loose.length);
	sections.push({
		title: text('Stored here {0} / {1}', { 0: state.storage.used, 1: state.storage.capacity }),
		rows: loose.map((p): UiRow => {
			const low = tooLow(p, hero);
			return {
				id: p.id,
				icon: p.icon,
				title: keyText(p.name),
				rarity: p.rarity,
				badge: text('{0}', {
					0: [
						keyText(slotDefs.get(p.slot)?.name ?? p.slot),
						...(p.set ? [keyText(p.set.name)] : []),
						...(p.minLevel ? [text('Lv {0}', { 0: p.minLevel })] : []),
					],
				}),
				lines: [...statLine(p), ...(low ? [{ text: low, tone: 'warn' as const }] : [])],
				facets: facetsOf(p),
				actions: storedActions(state, p, hero),
			};
		}),
		...(bulk.length ? { actions: bulk } : {}),
		lines: [
			...(loose.length
				? []
				: [{ text: text('Nothing stored here. Equipment drops in realms; an armory stores more.'), tone: 'muted' as const }]),
		],
	});
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
		sections,
		// The storage list narrowed in the browser by the same choices as smelting in bulk.
		...(facets ? { facets } : {}),
	};
}
