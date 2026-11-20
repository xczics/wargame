// The heroes plugin's words in its forms ("forms.prepare", src/shared/forms.ts), from the data `prepare` sends. The
// forms on a hero's card show, and are filled in, by the hero as the browser holds it (`heroes.list`, kept current by
// the commands: ./patch.ts; user 2026-11-20: "前端充分利用大对象的数据"): a hero sent off on another page loses its duty
// form at once, one that came back gets it. Without the heroes (not fetched yet) a form shows; the command checks.
import type { AllocateFormData, FormField, FormPart, FormPartInput, GiftFormData, HeroFormData, Meta } from '../../../src/shared/api';
import { defineClientPart } from '../../../src/shared/client-views';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import type { ListHero } from './patch';

// The server plugin's words (its i18n keys).
const text = uiTexts('heroes');

const NEEDS = ['heroes.list'];
/** The hero as held here: undefined while the heroes are not, null when it is not one of them (any more). */
function heroOf(id: string, input: FormPartInput): ListHero | null | undefined {
	const list = input.data<ListHero[]>('heroes.list');
	return list ? (list.find((h) => h.id === id) ?? null) : undefined;
}
const dutyOf = (input: FormPartInput, id: string) => input.meta('heroes')?.duties.find((d) => d.id === id);
/** Free to change what it does (not away leading an army, adventuring, injured...). */
const free = (input: FormPartInput, h: ListHero) => !!dutyOf(input, h.duty)?.manual;

// The GM's: where a candidate may be placed, "<settlement> · <venue>".
const gift: FormPart<GiftFormData> = (venues, { patch }) => ({
	...patch,
	options: {
		...patch.options,
		target: venues.map((v) => ({ value: v.value, label: text('{0} · {1}', { 0: v.settlement, 1: keyText(v.venue) }) })),
	},
});

// A free hero's duty, at the settlement it is attached to.
const assign: FormPart<HeroFormData> = (id, input) => {
	const h = heroOf(id, input);
	if (h === undefined) return input.patch;
	if (!h || !free(input, h)) return false;
	return { ...input.patch, defaults: { ...input.patch.defaults, hero: h.id, target: h.home, duty: h.duty } };
};

// Attached elsewhere, a hero on a post here leaves it.
const setHome: FormPart<HeroFormData> = (id, input) => {
	const h = heroOf(id, input);
	if (h === undefined) return input.patch;
	if (!h || !free(input, h)) return false;
	const post = dutyOf(input, h.duty);
	return {
		...input.patch,
		defaults: { ...input.patch.defaults, hero: h.id, settlement: h.home },
		...(h.duty !== 'idle' && post && !post.anywhere
			? { description: text('Moving ends the post of {0}.', { 0: keyText(post.name) }) }
			: {}),
	};
};

// Only an idle hero is let go.
const dismiss: FormPart<HeroFormData> = (id, input) => {
	const h = heroOf(id, input);
	if (h === undefined) return input.patch;
	return h?.duty === 'idle' ? input.patch : false;
};

/**
 * Spending free points: a row per attribute, where its value comes from (attrs = base + talent per level gained +
 * points spent; what other plugins add on top). Heroes from before the talent split grew at random: no talent column.
 * Pure: the tests run it.
 */
export function allocateFields(
	h: ListHero,
	bonus: Record<string, number>,
	attributes: NonNullable<Meta['heroes']>['attributes'],
): FormField[] {
	return attributes.map((a) => {
		const own = h.attrs[a.id] ?? 0;
		const talent = h.talents ? (h.talents[a.id] ?? 0) * (h.level - 1) : 0;
		const spent = h.alloc[a.id] ?? 0;
		const add = bonus[a.id] ?? 0;
		return {
			name: `points.${a.id}`,
			label: keyText(a.name),
			type: 'number' as const,
			min: 0,
			placeholder: text('0'),
			cells: [Math.round(own + add), own - talent - spent, h.talents ? talent : '–', add, spent],
		};
	});
}
const allocate: FormPart<AllocateFormData> = ({ hero, bonus }, input) => {
	const h = heroOf(hero, input);
	if (!h) return h === undefined ? input.patch : false;
	if (!h.freePoints) return false;
	const fields = allocateFields(h, bonus, input.meta('heroes')?.attributes ?? []);
	return {
		...input.patch,
		fields: [...(input.patch.fields ?? []), ...fields],
		defaults: { ...input.patch.defaults, hero: h.id, free: h.freePoints },
		budgets: [...(input.patch.budgets ?? []), { label: text('Free points'), use: fields.map((f) => f.name), capacity: { free: 1 } }],
	};
};

export const formParts = [
	defineClientPart({ point: 'forms.prepare', id: 'heroes.gift', part: gift }),
	defineClientPart({ point: 'forms.prepare', id: 'heroes.assign', part: assign, needs: NEEDS }),
	defineClientPart({ point: 'forms.prepare', id: 'heroes.setHome', part: setHome, needs: NEEDS }),
	defineClientPart({ point: 'forms.prepare', id: 'heroes.dismiss', part: dismiss, needs: NEEDS }),
	defineClientPart({ point: 'forms.prepare', id: 'heroes.allocate', part: allocate, needs: NEEDS }),
];
