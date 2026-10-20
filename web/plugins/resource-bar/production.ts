// The City page's production table (`resources.production`), assembled in the browser (AGENTS.md: the server sends
// data only) from production by source (`resources.sources`), the pool and the resources' names. Pure: the tests run it.
// A row per resource, per hour (the per-second numbers are too small to read); the stock and "Full" go by the client's
// counters, so the table needs nothing again until the rates change.
import type { ProductionRows, ResourceMeta, ResourcePool } from '../../../src/shared/api';
import { amount, signed, whole } from '../../../src/shared/format';
import { keyText, literal, uiTexts } from '../../../src/shared/i18n';
import type { TableData, UiText } from '../../../src/shared/ui';

// The resources plugin's own words (its i18n keys): the table reads as it did when the server built it.
const text = uiTexts('resources');

export function productionTable(
	rows: ProductionRows | null | undefined,
	pool: ResourcePool | null | undefined,
	resources: ResourceMeta[],
): TableData | null | undefined {
	if (rows === undefined) return undefined;
	if (rows === null) return null;
	const decimals = (n: number) => (Math.abs(n * 3600) < 100 ? 1 : 0);
	const hourly = (n: number) => amount(n * 3600, decimals(n));
	const change = (n: number) => signed(n * 3600, false, decimals(n));
	const bySource = (list: { source: UiText; amount: number }[], sign: 1 | -1) =>
		list.map((x) => text('{0} {1}/h', { 0: x.source, 1: change(sign * x.amount) }));
	const cap = pool?.capacity ?? 0;
	return {
		title: text('Production'),
		columns: [text('Resource'), text('Stock'), text('Net /h'), text('Output'), text('Bonuses'), text('Upkeep')],
		rows: resources.map((def) => {
			const row = rows[def.id] ?? { raw: 0, bonuses: [], upkeep: [], net: 0 };
			const bonus = row.bonuses.reduce((a, b) => a + b.amount, 0);
			const upkeep = row.upkeep.reduce((a, b) => a + b.amount, 0);
			return {
				id: def.id,
				cells: [
					{ text: text('{0} {1}', { 0: def.icon ?? '', 1: keyText(def.name) }) },
					{ text: literal(whole(pool?.amounts[def.id] ?? 0)), counter: `resource:${def.id}` },
					{
						text: literal(change(row.net)),
						...(row.net < 0 ? { tone: 'warn' as const } : {}),
						// At the cap nothing more comes in: only the net column says so.
						...(row.net > 0 ? { over: { counter: `resource:${def.id}`, amount: cap, text: text('Full'), tone: 'warn' as const } } : {}),
					},
					{ text: literal(hourly(row.raw)) },
					{
						text: literal(bonus ? change(bonus) : '—'),
						...(row.bonuses.length ? { hint: bySource(row.bonuses, 1) } : {}),
					},
					{
						text: literal(upkeep ? change(-upkeep) : '—'),
						...(row.upkeep.length ? { hint: bySource(row.upkeep, -1) } : {}),
					},
				],
			};
		}),
		lines: [{ text: text('Per hour. Hover a bonus or upkeep for where it comes from.'), tone: 'muted' }],
	};
}
