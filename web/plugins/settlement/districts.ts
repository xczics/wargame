// The City page's district board (`settlements.districts`, generic `ui.cells`), assembled in the browser (AGENTS.md:
// the server sends data only) from the settlement's outline (`settlements.outline`). Pure: the tests run it.
// The districts where they lie (3x3, 5x5 once the second ring is used), the inner city in the middle; free tiles where
// an outer city may go can be clicked to build one. Selecting a district shows its slots (filter "city.district").
import type { Meta, SettlementOutline } from '../../../src/shared/api';
import { amounts, resourceIcons } from '../../../src/shared/format';
import { keyText, literal, uiTexts } from '../../../src/shared/i18n';
import type { CellsData, UiCellItem } from '../../../src/shared/ui';

// The settlements plugin's own words (its i18n keys): the board reads as it did when the server built it.
const text = uiTexts('settlements');

export function districtBoard(
	d: SettlementOutline | null | undefined,
	resources: NonNullable<Meta['resources']>,
	bounds: Meta['map'],
): CellsData | null | undefined {
	if (d === undefined) return undefined;
	if (!d || (d.districts.length < 2 && !d.nextOuter)) return null;
	// Offsets as on the map, whose edges meet (the world map's `wrap`).
	const min = bounds?.min ?? 0;
	const size = (bounds?.max ?? 0) - min + 1;
	const wrap = (v: number) => (bounds ? ((((v - min) % size) + size) % size) + min : v);
	const icons = resourceIcons(resources);
	const terrain = (x: number, y: number) => d.terrain?.[`${x},${y}`];
	const terrainName = (x: number, y: number) => {
		const name = terrain(x, y)?.name;
		return name ? keyText(name) : text('');
	};
	const terrainText = (x: number, y: number) => {
		const t = terrain(x, y);
		if (!t) return text('');
		const bonus = Object.entries(t.bonus)
			.filter(([, v]) => v)
			.map(([r, v]) => `${icons[r] ?? r}${v > 0 ? '+' : ''}${v}%`)
			.join(' ');
		return bonus ? text('{0} {1}', { 0: keyText(t.name ?? t.terrain), 1: bonus }) : keyText(t.name ?? t.terrain);
	};
	const label = (type: string, idx: number) => (type === 'inner' ? text('Inner city') : text('Outer city {0}', { 0: idx }));
	const outer = d.districts.filter((x) => x.type === 'outer').length;
	const next = d.nextOuter;
	const placed: { dx: number; dy: number; district: boolean; item: UiCellItem }[] = [
		...d.districts.map((x) => ({
			dx: wrap(x.x - d.x),
			dy: wrap(x.y - d.y),
			district: true,
			item: {
				id: x.id,
				label: x.type === 'inner' ? text('Inner') : literal(String(x.idx)),
				sub: literal(`${x.used ?? 0}/${x.size}`),
				note: terrainName(x.x, x.y),
				title: text('{0} · {1}', { 0: [label(x.type, x.idx)], 1: [terrainText(x.x, x.y)] }),
				tone: x.type === 'inner' ? ('strong' as const) : ('solid' as const),
				selectable: true,
			},
		})),
		...(next?.candidates ?? []).map((c) => ({
			dx: wrap(c.x - d.x),
			dy: wrap(c.y - d.y),
			district: false,
			item: {
				id: `${c.x},${c.y}`,
				label: text('＋'),
				note: terrainName(c.x, c.y),
				title: text('{0} · {1}', { 0: [text('Build an outer city here')], 1: [terrainText(c.x, c.y)] }),
				tone: next!.blocked ? ('muted' as const) : ('add' as const),
				action: {
					command: 'settlements.addOuter',
					payload: { settlement: d.id, x: c.x, y: c.y },
					label: text('Build an outer city here'),
					...(next!.blocked ? { blocked: next!.blocked } : {}),
					confirm: text('Build an outer city at ({x}, {y})? {terrain} · cost {cost} · outer cities {n}/{limit}', {
						x: c.x,
						y: c.y,
						terrain: [terrainText(c.x, c.y)],
						cost: amounts(next!.cost, icons) || '—',
						n: outer + 1,
						limit: d.limits.outerTech,
					}),
				},
			},
		})),
	];
	const r = Math.max(1, ...placed.filter((p) => p.district).map((p) => Math.max(Math.abs(p.dx), Math.abs(p.dy))));
	// Rows from north (higher y) down, as on the map.
	const cells: (UiCellItem | null)[] = [];
	for (let row = 0; row <= 2 * r; row++)
		for (let col = 0; col <= 2 * r; col++) cells.push(placed.find((p) => p.dx === col - r && p.dy === r - row)?.item ?? null);
	return { title: text('Districts'), columns: 2 * r + 1, cells, defaultSelected: d.districts[0]?.id };
}
