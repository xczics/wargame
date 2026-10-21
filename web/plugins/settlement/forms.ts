// The settlements plugin's words in its forms ("forms.prepare", src/shared/forms.ts), from the data `prepare` sends.
import type { FormPart, OuterSlotsFormData, RenameFormData } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { keyText, uiTexts } from '../../../src/shared/i18n';

// The server plugin's words (its i18n keys).
const text = uiTexts('settlements');

// Never renamed: its name is the kind's key, which must not land in the text box (it would be saved as the name).
const rename: FormPart<RenameFormData> = ({ current }, { patch }) => ({
	...patch,
	description: text('Current name: {0}', { 0: keyText(current) }),
});

const addSlots: FormPart<OuterSlotsFormData> = (outer, { patch }) => ({
	...patch,
	options: {
		...patch.options,
		target: outer.map((d) => ({
			value: d.value,
			label: text('{0} · outer city {1} ({2}, {3}) · {4} slots', { 0: d.name, 1: d.idx, 2: d.x, 3: d.y, 4: d.slots }),
		})),
	},
});

export const formParts = [
	defineClientPart({ point: 'forms.prepare', id: 'settlements.rename', part: rename }),
	defineClientPart({ point: 'forms.prepare', id: 'settlements.addSlots', part: addSlots }),
];
