// The research plugin's words in its (GM) forms ("forms.prepare", src/shared/forms.ts), from the data `prepare` sends.
import type { FormPart, ResearchHastenFormData, TechLevelsFormData } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { keyText, uiTexts } from '../../../src/shared/i18n';

// The server plugin's words (its i18n keys).
const text = uiTexts('research');

const hasten: FormPart<ResearchHastenFormData> = (jobs, { patch }) => ({
	...patch,
	options: {
		...patch.options,
		settlement: jobs.map((j) => ({
			value: j.value,
			label: text('{0} · {1} Lv {2} · {3} min', { 0: j.settlement, 1: j.tech, 2: j.level, 3: j.minutes }),
		})),
	},
});

const setLevel: FormPart<TechLevelsFormData> = (techs, { patch }) => ({
	...patch,
	options: {
		...patch.options,
		tech: techs.map((t) => ({ value: t.id, label: text('{0} (Lv {1}/{2})', { 0: keyText(t.name), 1: t.level, 2: t.max }) })),
	},
});

export const formParts = [
	defineClientPart({ point: 'forms.prepare', id: 'research.hasten', part: hasten }),
	defineClientPart({ point: 'forms.prepare', id: 'research.setLevel', part: setLevel }),
];
