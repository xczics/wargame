// The settling plugin's words in its form ("forms.prepare", src/shared/forms.ts): the kinds the player may found now,
// "City (1/3) — <cost>", from the data `prepare` sends (names and icons from the meta).
import type { FormPart, SettlingFormData } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { costVar, isFree, keyText, uiTexts } from '../../../src/shared/i18n';

// The server plugin's words (its i18n keys).
const text = uiTexts('settling');

const found: FormPart<SettlingFormData> = ({ kinds }, { patch, meta }) => {
	const resources = meta('resources') ?? [];
	const names = new Map((meta('settlementKinds') ?? []).map((k) => [k.id, k.name]));
	return {
		...patch,
		options: {
			...patch.options,
			kind: kinds.map((k) => ({
				value: k.kind,
				label: text('{0} ({1}/{2}) — {3}', {
					0: keyText(names.get(k.kind) ?? k.kind),
					1: k.have,
					2: k.limit ?? '∞',
					3: isFree(costVar(k.cost, resources)) ? text('free') : costVar(k.cost, resources),
				}),
			})),
		},
	};
};

export const formParts = [defineClientPart({ point: 'forms.prepare', id: 'settling.found', part: found })];
