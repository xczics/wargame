// The selected settlement's gear rows (`equipment.gear`, generic `ui.rows`), assembled in the browser (AGENTS.md: the
// server sends data only) from `equipment.state`. Pure: the tests run it. What the chosen hero wears, accessory slots as
// a row of cells, and what the settlement stores.
import type { EquipmentState } from '../../../src/shared/api';
import { amount, amounts } from '../../../src/shared/format';
import { nameKey } from '../../../src/shared/heroes';
import { keyText, literal, uiTexts } from '../../../src/shared/i18n';
import type { RowsData, UiCellItem, UiLine, UiRow, UiText } from '../../../src/shared/ui';

// The equipment plugin's own words (its i18n keys): the rows read as they did when the server built them.
const text = uiTexts('equipment');

const FACET_LABEL = { rarity: 'Colour', set: 'Set', slot: 'Slot' } as const;

type Piece = EquipmentState['pieces'][number];

export function gearRows(state: EquipmentState | null | undefined): RowsData | null | undefined {
	if (!state) return state;
	const hero = state.heroes.find((h) => h.id === state.hero);
	const slotDefs = new Map(state.slots.map((x) => [x.id, x]));
	const stats = (p: Piece): UiText[] => p.stats.map((x) => text('{0} +{1}', { 0: keyText(x.name), 1: amount(x.value, 1) }));
	const statLine = (p: Piece): UiLine[] => (p.stats.length ? [{ text: text('{0}', { 0: stats(p) }) }] : []);
	const takeOff = (p: Piece) => ({ command: 'equipment.unequip', payload: { piece: p.id }, label: text('Take off') });
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
						...(p.stats.length ? { note: text('{0}', { 0: stats(p) }) } : {}),
						rarity: p.rarity,
						tone: 'solid',
						title: text('{0} · {1}', { 0: [keyText(p.name)], 1: stats(p) }),
						action: takeOff(p),
					}
				: { id: `empty${i}`, label: text('＋'), title: text('Empty: wear one from the storage below') };
		});
		if (cells.length) sections.push({ title: text('Accessories ({0})', { 0: limit }), rows: [], cells });
	}
	const s = state.settlement;
	const loose = state.pieces.filter((p) => !p.hero);
	const facets = (p: Piece) => ({ rarity: p.rarity, set: p.set?.id ?? '', slot: p.slot });
	sections.push({
		title: text('Stored here {0} / {1}', { 0: state.storage.used, 1: state.storage.capacity }),
		rows: loose.map((p): UiRow => {
			const tooLow = !!p.minLevel && (hero?.level ?? 0) < p.minLevel;
			const needs = text('Needs a hero of level {0}', { 0: p.minLevel ?? 0 });
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
				lines: [...statLine(p), ...(hero && tooLow ? [{ text: needs, tone: 'warn' as const }] : [])],
				facets: facets(p),
				actions: [
					...(hero
						? [
								{
									command: 'equipment.equip',
									payload: { piece: p.id, hero: hero.id },
									label: text('Wear'),
									...(tooLow ? { blocked: needs } : {}),
								},
							]
						: []),
					{
						command: 'equipment.smelt',
						payload: { piece: p.id },
						label: text('Dismantle ({0})', { 0: amounts(state.smelt[p.id] ?? {}, state.icons) }),
						confirm: text('Dismantle this piece?'),
					},
				],
			};
		}),
		...(loose.length > 1
			? {
					actions: [
						{
							entry: { kind: 'equipment-smelt', id: s, label: text('Smelt in bulk'), data: { settlement: s } },
							label: text('Smelt in bulk'),
						},
					],
				}
			: {}),
		lines: [
			...(loose.length
				? []
				: [{ text: text('Nothing stored here. Equipment drops in realms; an armory stores more.'), tone: 'muted' as const }]),
		],
	});
	// The colours, sets and slots the stored pieces have (none other offered), as smelting in bulk offers them.
	const used = (key: 'rarity' | 'set' | 'slot') => new Set(loose.map((p) => facets(p)[key]));
	const sets = new Map(loose.flatMap((p) => (p.set ? [[p.set.id, p.set.name] as const] : [])));
	const choices = {
		rarity: state.rarities.filter((r) => used('rarity').has(r.id)).map((r) => ({ value: r.id, label: keyText(r.name) })),
		set: [...used('set')].filter(Boolean).map((id) => ({ value: id, label: sets.has(id) ? keyText(sets.get(id)!) : literal(id) })),
		slot: state.slots.filter((x) => used('slot').has(x.id)).map((x) => ({ value: x.id, label: keyText(x.name) })),
	};
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
		// The storage list narrowed in the browser by the same choices as smelting in bulk (user 2026-10-19:
		// "筛选功能不止用于拆解，也用于减小列表长度").
		...(loose.length > 1
			? {
					facets: (['rarity', 'set', 'slot'] as const)
						.map((id) => ({
							id,
							label: text(FACET_LABEL[id]),
							options: [{ value: '', label: text('Any') }, ...choices[id]],
						}))
						.filter((f) => f.options.length > 2),
				}
			: {}),
	};
}
