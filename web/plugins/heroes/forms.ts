// The heroes plugin's words in its forms ("forms.prepare", src/shared/forms.ts), from the data `prepare` sends.
import type { FormPart, GiftFormData } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { keyText, uiTexts } from '../../../src/shared/i18n';

// The server plugin's words (its i18n keys).
const text = uiTexts('heroes');

// The GM's: where a candidate may be placed, "<settlement> · <venue>".
const gift: FormPart<GiftFormData> = (venues, { patch }) => ({
	...patch,
	options: {
		...patch.options,
		target: venues.map((v) => ({ value: v.value, label: text('{0} · {1}', { 0: v.settlement, 1: keyText(v.venue) }) })),
	},
});

// Attached elsewhere, a hero on a post here leaves it (the duty's name key).
const setHome: FormPart<string> = (duty, { patch }) => ({
	...patch,
	description: text('Moving ends the post of {0}.', { 0: keyText(duty) }),
});

export const formParts = [
	defineClientPart({ point: 'forms.prepare', id: 'heroes.gift', part: gift }),
	defineClientPart({ point: 'forms.prepare', id: 'heroes.setHome', part: setHome }),
];
