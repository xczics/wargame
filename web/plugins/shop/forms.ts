// The shop plugin's words in its (GM) form ("forms.prepare", src/shared/forms.ts): the player's coupons now.
import type { FormPart } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { uiTexts } from '../../../src/shared/i18n';

// The server plugin's words (its i18n keys).
const text = uiTexts('shop');

const grant: FormPart<number> = (balance, { patch }) => ({ ...patch, description: text('Balance: {0}', { 0: balance }) });

export const formParts = [defineClientPart({ point: 'forms.prepare', id: 'shop.grant', part: grant })];
