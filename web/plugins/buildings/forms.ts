// The buildings plugin's words in its (GM) forms ("forms.prepare", src/shared/forms.ts), from the data `prepare` sends:
// the player's buildings, "<settlement> · <building> Lv 3/7".
import type { FormPart, PlacedFormData } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { keyText, uiTexts } from '../../../src/shared/i18n';

// The server plugin's words (its i18n keys).
const text = uiTexts('buildings');

const placed: FormPart<PlacedFormData> = (list, { patch, meta }) => {
	const names = new Map((meta('buildings') ?? []).map((b) => [b.id, b.name]));
	const target = list.map((p) => {
		const name = keyText(names.get(p.building) ?? p.building);
		return {
			value: p.value,
			label:
				p.cap === undefined
					? text('{0} · {1} Lv {2}', { 0: p.settlement, 1: name, 2: p.level })
					: text('{0} · {1} Lv {2}/{3}', { 0: p.settlement, 1: name, 2: p.level, 3: p.cap }),
		};
	});
	return { ...patch, options: { ...patch.options, target } };
};

export const formParts = [
	defineClientPart({ point: 'forms.prepare', id: 'buildings.raiseCap', part: placed }),
	defineClientPart({ point: 'forms.prepare', id: 'buildings.setLevel', part: placed }),
];
