// The troops plugin's words in its forms ("forms.prepare", src/shared/forms.ts): from what `prepare` sends as data (the
// units a barracks can train now, with their costs, times and limits), the choices, "at most" and the time's sources.
import type { FormPart, TrainFormData } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { amounts, resourceIcons } from '../../../src/shared/format';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import { factorTexts } from '../../../src/shared/stats';

// The server plugin's words (its i18n keys).
const text = uiTexts('troops');

const train: FormPart<TrainFormData> = (d, { patch, meta }) => {
	const icons = resourceIcons(meta('resources') ?? []);
	const names = new Map((meta('units') ?? []).map((u) => [u.id, u.name]));
	const about = text(
		d.busy ? 'Queued after the batch training now: paid now, refunded if cancelled before it starts.' : 'Costs and time are per unit.',
	);
	const time = factorTexts(d.time);
	return {
		...patch,
		options: {
			...patch.options,
			unit: d.units.map((u) => ({
				value: u.unit,
				label: text('{0} — {1} · {2}s each', { 0: keyText(names.get(u.unit) ?? u.unit), 1: amounts(u.cost, icons), 2: u.seconds }),
			})),
		},
		atMostBy: { ...patch.atMostBy, count: { field: 'unit', values: Object.fromEntries(d.units.map((u) => [u.unit, u.most])) } },
		description: time.length ? text('{0} Training time: {1}', { 0: about, 1: time }) : about,
	};
};

export const formParts = [defineClientPart({ point: 'forms.prepare', id: 'troops.train', part: train })];
