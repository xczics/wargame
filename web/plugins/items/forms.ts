// The items plugin's words in every item's form ("forms.prepare", src/shared/forms.ts), after the item's own part:
// "<what that part says, or the item's description>" (the count is on the card the form opens from).
import type { FormPart, ItemUseFormData } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { keyText, uiTexts } from '../../../src/shared/i18n';

// The server plugin's words (its i18n keys).
const text = uiTexts('items');

// Shown while one is held, and how many, from the inventory in the big object (user 2026-11-20: "前端充分利用大对象的
// 数据"; bought in the shop, the form came only with the next sync while the server decided it): it follows a purchase
// or a use at once. Without the inventory (not fetched yet) the form shows; the command checks.
const use: FormPart<ItemUseFormData> = (_marker, { command, patch, meta, data }) => {
	const item = command.slice('items.use.'.length);
	const owned = data<Record<string, number>>('items.owned');
	const have = owned ? (owned[item] ?? 0) : undefined;
	if (have !== undefined && have < 1) return false;
	const own = meta('items')?.find((i) => i.id === item)?.description;
	const desc = patch.description ?? (own ? keyText(own) : undefined);
	if (have === undefined) return desc ? { ...patch, description: desc } : patch;
	return { ...patch, description: desc ? text('{0} (you have {1})', { 0: desc, 1: have }) : text('(you have {0})', { 0: have }) };
};

export const formParts = [defineClientPart({ point: 'forms.prepare', id: 'items.use', part: use, needs: ['items.owned'] })];
