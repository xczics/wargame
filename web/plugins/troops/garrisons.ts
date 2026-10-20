// The Army page's garrisons (`troops.garrisons`), assembled in the browser (AGENTS.md: the server sends data only) from
// the garrisons as data (`troops.state`) and the meta's unit names and resource icons. Pure: the tests run it.
// One section per settlement (its title selects it), a row per unit, then strength, upkeep and training.
import type { ResourceMeta, TroopsState, UnitMeta } from '../../../src/shared/api';
import { amount, amounts } from '../../../src/shared/format';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import { factorTexts } from '../../../src/shared/stats';
import type { RowsData } from '../../../src/shared/ui';

// The troops plugin's own words (its i18n keys): the rows read as they did when the server built them.
const text = uiTexts('troops');

export function garrisonRows(
	state: TroopsState | undefined,
	units: UnitMeta[] | undefined,
	resources: ResourceMeta[] | undefined,
): RowsData | undefined {
	if (state === undefined) return undefined;
	const defs = new Map((units ?? []).map((u) => [u.id, u]));
	const icons = Object.fromEntries((resources ?? []).map((r) => [r.id, r.icon ?? r.id]));
	const one = (v: number) => amount(v, 1);
	const sections: RowsData['sections'] = state.garrisons.map((g) => {
		const upkeep = Object.fromEntries(Object.entries(g.upkeep).map(([r, v]) => [r, v * 3600]));
		const waiting = g.training.filter((b) => b.finishesAt === null).length;
		return {
			title: g.name,
			actions: [{ params: { settlement: g.settlement }, label: text('Select') }],
			current: g.settlement === state.selected,
			rows: g.units.map((u) => ({
				id: u.id,
				...(defs.get(u.id)?.icon ? { icon: defs.get(u.id)!.icon } : {}),
				title: text('{unit} ×{n}', { unit: keyText(defs.get(u.id)?.name ?? u.id), n: amount(u.count) }),
				lines: [{ text: text('atk {a} · def {d} · hp {h}', { a: one(u.attack), d: one(u.defense), h: one(u.hp) }), tone: 'muted' }],
			})),
			lines: [
				...(g.units.length
					? [
							{
								text: text('Strength: attack {a} · defense {d} · hp {h}', {
									a: amount(g.power.attack),
									d: amount(g.power.defense),
									h: amount(g.power.hp),
								}),
							},
						]
					: [{ text: text('No troops stationed here.'), tone: 'muted' as const }]),
				...(Object.keys(upkeep).length
					? [{ text: text('Upkeep: {list}/h', { list: amounts(upkeep, icons, 1) }), tone: 'muted' as const }]
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
