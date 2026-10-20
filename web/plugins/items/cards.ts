// The Items page's cards (`items.cards`) and the item buttons elsewhere (`items.shortcuts`), assembled in the browser
// (AGENTS.md: the server sends data only) from how many of each item the player has (`items.owned`), other plugins'
// data for their groups (`items.extra`) and the statics (`items.catalog`, `items.shortcut-cards`). Pure: the tests
// run them. The items plugin's own words (its i18n keys), as when the server built them.
import type { ItemCatalog, ItemsExtra } from '../../../src/shared/api';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import { itemCardsOf } from '../../../src/shared/items';
import type { CardsData } from '../../../src/shared/ui';

const text = uiTexts('items');

/** Categories (ui.filters), owned items as tiles (ui.cards); opening one shows its description and use form. */
export function itemCards(
	owned: Record<string, number> | undefined,
	extra: ItemsExtra | undefined,
	catalog: ItemCatalog | undefined,
): CardsData | undefined {
	if (!owned || !extra || !catalog) return undefined;
	const list = catalog.items.filter((d) => (owned[d.id] ?? 0) > 0);
	const more = extra.flatMap((x) => {
		const group = itemCardsOf(x.source)?.(x.data);
		return group && group.cards.length ? [group] : [];
	});
	return {
		title: text('Items'),
		allTitle: text('All items'),
		groups: [
			...[...new Set(list.map((d) => d.category))].map((c) => ({ id: c, label: keyText(catalog.categories[c]) })),
			...more.map((m) => m.group),
		],
		cards: [
			...list.map((d) => ({
				id: d.id,
				group: d.category,
				...(d.icon ? { icon: d.icon } : {}),
				title: keyText(d.name),
				...(d.rarity ? { rarity: d.rarity } : {}),
				count: owned[d.id],
				...(d.description ? { text: keyText(d.description) } : {}),
				detail: d.usable
					? {
							lines: [text('Usable items apply to the selected settlement.')],
							form: { placement: 'items', command: `items.use.${d.id}` },
						}
					: { lines: [text('This item is not used from here.')] },
			})),
			...more.flatMap((m) => m.cards.map((c) => ({ ...c, group: m.group.id }))),
		],
		empty: text('Your inventory is empty.'),
	};
}

/** Over the static shortcut cards: how many the player has of each item with a button elsewhere. */
export function itemShortcuts(owned: Record<string, number> | undefined, shortcuts: CardsData | undefined): CardsData | undefined {
	if (!owned || !shortcuts) return undefined;
	const counters: Record<string, number> = {};
	for (const c of shortcuts.cards) if (c.countFrom) counters[c.countFrom] = owned[c.countFrom.slice('item:'.length)] ?? 0;
	return { base: 'items.shortcut-cards', cards: [], counters };
}
