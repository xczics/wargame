// The starter-levies plugin's words in its levy orders' forms ("forms.prepare", src/shared/forms.ts): the quota now.
import type { FormPart } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { uiTexts } from '../../../src/shared/i18n';

// The server plugin's words (its i18n keys).
const text = uiTexts('starter-levies');

const quota: FormPart<number> = (n, { patch }) => ({ ...patch, description: text('Quota now: {0}', { 0: n }) });

export const formParts = [defineClientPart({ point: 'forms.prepare', id: 'starter-levies.quota', part: quota })];
