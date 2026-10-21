// The pvp plugin's words in its (GM) form ("forms.prepare", src/shared/forms.ts): the beginner protection left.
import type { FormPart } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { duration } from '../../../src/shared/format';
import { uiTexts } from '../../../src/shared/i18n';

// The server plugin's words (its i18n keys).
const text = uiTexts('pvp');

const protect: FormPart<number> = (seconds, { patch }) => ({
	...patch,
	description: seconds > 0 ? text('Protected for {0} more.', { 0: duration(seconds) }) : text('Not protected.'),
});

export const formParts = [defineClientPart({ point: 'forms.prepare', id: 'pvp.protect', part: protect })];
