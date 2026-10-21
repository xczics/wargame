// The armies plugin's words in its forms ("forms.prepare", src/shared/forms.ts): in those sending troops, the supplies'
// boxes, "<resource> (supplies)" and, for a transport, "<resource> (to fetch)" (their labels come as the resources'
// names); the GM's speed-up, from the data `prepare` sends.
import type { ArmiesHastenFormData, FormPart } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { uiTexts } from '../../../src/shared/i18n';

// The server plugin's words (its i18n keys).
const text = uiTexts('armies');

const supplies: FormPart<Record<string, never>> = (_d, { patch }) => ({
	...patch,
	fields: patch.fields?.map((f) =>
		f.name.startsWith('cargo.')
			? { ...f, label: text('{0} (supplies)', { 0: f.label }) }
			: f.name.startsWith('pickup.')
				? { ...f, label: text('{0} (to fetch)', { 0: f.label }) }
				: f,
	),
});

// The GM's: marches on their way, with the minutes left of the current leg.
const hasten: FormPart<ArmiesHastenFormData> = (marches, { patch }) => ({
	...patch,
	options: {
		...patch.options,
		id: marches.map((m) => ({
			value: m.id,
			label: text(m.outbound ? '({0}, {1}) · Outbound · {2} min' : '({0}, {1}) · Returning · {2} min', { 0: m.x, 1: m.y, 2: m.minutes }),
		})),
	},
});

export const formParts = [
	defineClientPart({ point: 'forms.prepare', id: 'armies.supplies', part: supplies }),
	defineClientPart({ point: 'forms.prepare', id: 'armies.hasten', part: hasten }),
];
