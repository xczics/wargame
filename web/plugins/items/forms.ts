// The items plugin's words in every item's form ("forms.prepare", src/shared/forms.ts), after the item's own part:
// "<what that part says, or the item's description> (you have 3)".
import type { FormPart, ItemUseFormData } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { keyText, uiTexts } from '../../../src/shared/i18n';

// The server plugin's words (its i18n keys).
const text = uiTexts('items');

const use: FormPart<ItemUseFormData> = (have, { command, patch, meta }) => {
	const item = command.slice('items.use.'.length);
	const own = meta('items')?.find((i) => i.id === item)?.description;
	const desc = patch.description ?? (own ? keyText(own) : undefined);
	return { ...patch, description: desc ? text('{0} (you have {1})', { 0: desc, 1: have }) : text('(you have {0})', { 0: have }) };
};

export const formParts = [defineClientPart({ point: 'forms.prepare', id: 'items.use', part: use })];
