// The realms plugin's words in its forms ("forms.prepare", src/shared/forms.ts), from the data `prepare` sends.
import type { AdventureFormData, FormPart, RealmsHastenFormData } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { keyText, uiTexts } from '../../../src/shared/i18n';

// The server plugin's words (its i18n keys).
const text = uiTexts('realms');

// Runs: this one, then that many more one after another (a loss stops them). Heroes by name key (spelled here).
const adventure: FormPart<AdventureFormData> = ({ repeats, heroes }, { patch }) => ({
	...patch,
	options: {
		...patch.options,
		repeat: Array.from({ length: repeats + 1 }, (_, n) => ({ value: String(n), label: text('{0} ×', { 0: n + 1 }) })),
		hero: heroes.map((h) => ({ value: h.id, label: text('{0} (Lv {1})', { 0: h.name, 1: h.level }) })),
	},
});

// The GM's: heroes away adventuring or being treated, with the minutes left.
const hasten: FormPart<RealmsHastenFormData> = (away, { patch }) => ({
	...patch,
	options: {
		...patch.options,
		hero: away.map((a) => ({
			value: a.hero,
			label:
				a.realm === null
					? text('{0} · treatment · {1} min', { 0: a.name, 1: a.minutes })
					: text('{0} · {1} · {2} min', { 0: a.name, 1: keyText(a.realm), 2: a.minutes }),
		})),
	},
});

export const formParts = [
	defineClientPart({ point: 'forms.prepare', id: 'realms.adventure', part: adventure }),
	defineClientPart({ point: 'forms.prepare', id: 'realms.hasten', part: hasten }),
];
