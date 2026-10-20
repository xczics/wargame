// Each barracks' queue for the generic timers widget on its entry (`troops.training`), assembled in the browser
// (AGENTS.md: the server sends data only) from the garrison (`troops.garrison`) and the units' names. Pure: the tests
// run it. The batch training, then the plans (cancellable for a refund); or why nothing can be trained there now.
import type { GarrisonInfo, Meta } from '../../../src/shared/api';
import { amounts, resourceIcons } from '../../../src/shared/format';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import type { TimersData, UiTimer } from '../../../src/shared/ui';

// The troops plugin's own words (its i18n keys): the queue reads as it did when the server built it.
const text = uiTexts('troops');

export function trainingTimers(
	info: GarrisonInfo | null | undefined,
	units: NonNullable<Meta['units']>,
	resources: NonNullable<Meta['resources']>,
): TimersData | null | undefined {
	if (info === undefined) return undefined;
	if (info === null) return null;
	const defs = new Map(units.map((u) => [u.id, u]));
	const icons = resourceIcons(resources);
	const items = info.training.map((b): UiTimer => {
		const title = text('{unit} ×{n}', { unit: keyText(defs.get(b.unit)?.name ?? b.unit), n: b.count });
		return b.startedAt !== null
			? { id: b.id, where: b.line, title, startedAt: b.startedAt, endsAt: b.finishesAt! }
			: {
					id: b.id,
					where: b.line,
					title,
					lines: [{ text: text('Waiting · {cost}', { cost: amounts(b.cost, icons) }), tone: 'muted' }],
					actions: [
						{
							command: 'troops.cancel',
							payload: { settlement: info.settlement, id: b.id },
							label: text('Cancel (refund)'),
							confirm: text('Cancel this training plan? Its cost comes back.'),
						},
					],
				};
	});
	const notes: NonNullable<TimersData['notes']> = [];
	for (const line of new Set(units.flatMap((d) => (d.trainedAt ? [d.trainedAt] : [])))) {
		if (items.some((i) => i.where === line)) {
			notes.push({
				where: line,
				text: text('Paid when added; plans waiting cannot be plundered, and cancelling one returns its cost.'),
				tone: 'muted',
			});
			continue;
		}
		const here = info.trainable.filter((t) => defs.get(t.unit)?.trainedAt === line);
		if (here.length && here.every((t) => t.blocked)) notes.push({ where: line, text: here[0].blocked!, tone: 'muted' });
	}
	return { title: text('Training'), items, notes };
}
