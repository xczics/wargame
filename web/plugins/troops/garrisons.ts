// The Army page's garrisons (`troops.garrisons`), assembled in the browser (AGENTS.md: the server sends data only) from
// the garrisons as data (`troops.state`), the meta's unit names and resource icons and the units' numbers under the rules
// (static `troops.units`: no bonuses, as the server's strength was). Pure: the tests run it.
// One section per settlement (its title selects it), folded to its count and upkeep (user 2026-11-04: "每座城池只显示
// 摘要（总数+消耗），点开之后分三列展示，每行一个级别。然后鼠标放上去时浮现单兵属性"): unfolded, a table of the
// units (a family a column, a tier a row; one unit's numbers on hover), then strength, upkeep and training.
import type { ResourceMeta, TroopsState, UnitCatalog, UnitMeta, UnitStatsPart } from '../../../src/shared/api';
import type { ClientViewGet } from '../../../src/shared/client-views';
import { amount } from '../../../src/shared/format';
import { costVar, keyText, uiTexts } from '../../../src/shared/i18n';
import { factorTexts } from '../../../src/shared/stats';
import { unitTotals } from '../../../src/shared/troops';
import type { RowsData, UiGrid, UiGridCell } from '../../../src/shared/ui';

// The troops plugin's own words (its i18n keys): the rows read as they did when the server built them.
const text = uiTexts('troops');

export function garrisonRows(
	state: TroopsState | undefined,
	units: UnitMeta[] | undefined,
	resources: ResourceMeta[] | undefined,
	numbers: UnitCatalog | undefined,
	families: readonly { id: string; name: string; icon?: string }[] = [],
	/** Other client plugins' words for their units' hover ("troops.unitStats"), and what they read with. */
	stats?: { parts: ReadonlyMap<string, UnitStatsPart>; get: ClientViewGet },
): RowsData | undefined {
	if (state === undefined || !numbers) return undefined;
	const defs = new Map((units ?? []).map((u) => [u.id, u]));
	const sections: RowsData['sections'] = state.garrisons.map((g) => {
		const upkeep = Object.fromEntries(Object.entries(g.upkeep).map(([r, v]) => [r, v * 3600]));
		const waiting = g.training.filter((b) => b.finishesAt === null).length;
		const power = unitTotals(Object.fromEntries(g.units.map((u) => [u.id, u.count])), (id) => numbers[id]);
		const total = g.units.reduce((a, u) => a + u.count, 0);
		const upkeepLine = Object.keys(upkeep).length
			? [{ text: text('Upkeep: {list}/h', { list: costVar(upkeep, resources ?? [], { decimals: 1 }) }), tone: 'muted' as const }]
			: [];
		return {
			title: g.name,
			actions: [{ params: { settlement: g.settlement }, label: text('Select') }],
			current: g.settlement === state.selected,
			fold: {
				summary: g.units.length
					? [{ text: text('{n} troops in all', { n: amount(total) }) }, ...upkeepLine]
					: [{ text: text('No troops stationed here.'), tone: 'muted' as const }],
			},
			rows: [],
			...(g.units.length ? { grid: unitGrid(g.units, defs, numbers, families, stats) } : {}),
			lines: [
				...(g.units.length
					? [
							{
								text: text('Strength: attack {a} · defense {d} · hp {h}', {
									a: amount(power.attack),
									d: amount(power.defense),
									h: amount(power.hp),
								}),
							},
						]
					: []),
				...(g.upkeepBy.length ? [{ text: text('Upkeep changed by: {0}', { 0: factorTexts(g.upkeepBy) }), tone: 'muted' as const }] : []),
				...g.training
					.filter((b) => b.finishesAt !== null)
					.map((b) => ({
						text: text('Training {unit} ×{n}', { unit: keyText(defs.get(b.unit)?.name ?? b.unit), n: b.count }),
						tone: 'muted' as const,
						endsAt: b.finishesAt!,
					})),
				...(waiting ? [{ text: text('{n} training plans waiting', { n: waiting }), tone: 'muted' as const }] : []),
			],
		};
	});
	return {
		title: text('Garrisons'),
		sections,
		notes: [
			{ text: text('Train troops in the barracks (open the building on the Overview page).'), tone: 'muted' },
			{
				text: text('— if a resource runs out, troops that need it leave (or drop a tier) bit by bit until upkeep fits.'),
				tone: 'muted',
			},
		],
	};
}

/**
 * The units as a table: a column per family that fights in a lane (the meta's order), a row per tier; units of no such
 * family (supply, carts, medics: user 2026-11-04 "辎重似乎要单开一列") in a column of their own, one under another; on
 * hover what they are for, from the plugin that defined them ("辅助兵种的属性显示前端要有单独的分支"; "主要显示速度、容量").
 */
function unitGrid(
	units: { id: string; count: number }[],
	defs: Map<string, UnitMeta>,
	numbers: UnitCatalog,
	families: readonly { id: string; name: string; icon?: string }[],
	stats?: { parts: ReadonlyMap<string, UnitStatsPart>; get: ClientViewGet },
): UiGrid {
	const one = (v: number) => amount(v, 1);
	const familyOf = (id: string) => defs.get(id)?.family;
	const fighting = (id: string) => families.some((f) => f.id === familyOf(id));
	const present = new Set(units.map((u) => familyOf(u.id)));
	const lanes = families.filter((f) => present.has(f.id));
	const support = units.filter((u) => !fighting(u.id));
	const cell = (u: { id: string; count: number }): UiGridCell => {
		const def = defs.get(u.id);
		const n = numbers[u.id];
		return {
			...(def?.icon ? { icon: def.icon } : {}),
			// Its column says the family and its row the tier: the icon and how many (user 2026-11-04: "溢出了…或者只用
			// 图标呢"); its name on hover.
			text: text('×{n}', { n: amount(u.count) }),
			hint: [keyText(def?.name ?? u.id), ...own(u.id, n)],
		};
	};
	// The plugin that defined a unit words it (e.g. a cart's seats); else a fighter's attack, defence and hp, and a
	// unit standing in no lane (no fight in it) its speed.
	const own = (id: string, n: UnitCatalog[string] | undefined) => {
		if (stats)
			for (const part of stats.parts.values()) {
				const said = part(id, n, stats.get);
				if (said) return said;
			}
		if (!n) return [];
		return fighting(id)
			? [text('atk {a} · def {d} · hp {h}', { a: one(n.attack), d: one(n.defense), h: one(n.hp) })]
			: [text('speed {s} tiles/h', { s: amount(n.speed) })];
	};
	const tiers = [...new Set(units.filter((u) => fighting(u.id)).map((u) => defs.get(u.id)?.tier ?? 0))].sort((a, b) => a - b);
	const rows = Array.from({ length: Math.max(tiers.length, support.length) }, (_, i) => {
		const tier = tiers[i];
		const cells: (UiGridCell | null)[] = lanes.map((f) => {
			// One unit a family and tier (as in the starter content); were there two, the first.
			const u = tier === undefined ? undefined : units.find((x) => familyOf(x.id) === f.id && (defs.get(x.id)?.tier ?? 0) === tier);
			return u ? cell(u) : null;
		});
		if (support.length) cells.push(support[i] ? cell(support[i]) : null);
		return { label: tier === undefined ? text('') : text('Tier {0}', { 0: tier }), cells };
	});
	return {
		columns: [
			...lanes.map((f) => ({ label: keyText(f.name), ...(f.icon ? { icon: f.icon } : {}) })),
			...(support.length ? [{ label: text('Supply train') }] : []),
		],
		rows,
	};
}
