// The starter-realms plugin's words in a realm key's form ("forms.prepare", src/shared/forms.ts): its choices, from the
// data `prepare` sends.
import type { FormOption, FormPart, StarterRealmsKeyData } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { uiTexts } from '../../../src/shared/i18n';

// The server plugin's words (its i18n keys).
const text = uiTexts('starter-realms');

const key: FormPart<StarterRealmsKeyData> = ({ realm, open, trade }, { patch }) => {
	const action: FormOption[] = [
		...(open ? [] : [{ value: 'unlock', label: text('Open {0}', { 0: realm }) }]),
		...(trade !== null ? [{ value: 'exchange', label: text('Trade for {0} of every resource', { 0: trade }) }] : []),
	];
	return { ...patch, options: { ...patch.options, action } };
};

export const formParts = [defineClientPart({ point: 'forms.prepare', id: 'starter-realms.key', part: key })];
