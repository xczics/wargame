/**
 * Mapping every text of a command form (titles, labels, options...), e.g. to make them i18n keys of the
 * plugin they come from when another plugin registers the form for it.
 */
import { mapUiTexts } from '../shared/i18n';
import type { CommandForm, FormPatch } from './types';

type Field = CommandForm['fields'][number];

const mapField = (f: Field, map: (text: string) => string): Field => ({
	...f,
	label: map(f.label),
	...(f.placeholder ? { placeholder: map(f.placeholder) } : {}),
	...(f.options ? { options: f.options.map((o) => ({ ...o, label: map(o.label) })) } : {}),
	// A widget's data (e.g. a formation editor's lanes) carries UiTexts.
	...(f.data !== undefined ? { data: mapUiTexts(structuredClone(f.data), map) } : {}),
});

/** A form with every text mapped (its `prepare` keeps returning patches as it did: map those with `mapPatchTexts`). */
export function mapFormTexts<F extends Omit<CommandForm, 'placement'>>(form: F, map: (text: string) => string): F {
	return {
		...form,
		title: map(form.title),
		...(form.description ? { description: map(form.description) } : {}),
		...(form.submitLabel ? { submitLabel: map(form.submitLabel) } : {}),
		...(form.confirm ? { confirm: map(form.confirm) } : {}),
		fields: form.fields.map((f) => mapField(f, map)),
		...(form.budgets ? { budgets: form.budgets.map((b) => ({ ...b, label: map(b.label) })) } : {}),
	};
}

/** A form patch with every text mapped. */
export function mapPatchTexts(patch: FormPatch, map: (text: string) => string): FormPatch {
	return {
		...patch,
		...(patch.fields ? { fields: patch.fields.map((f) => mapField(f, map)) } : {}),
		...(patch.options
			? {
					options: Object.fromEntries(
						Object.entries(patch.options).map(([k, list]) => [k, list.map((o) => ({ ...o, label: map(o.label) }))]),
					),
				}
			: {}),
		...(patch.description ? { description: map(patch.description) } : {}),
		...(patch.budgets ? { budgets: patch.budgets.map((b) => ({ ...b, label: map(b.label) })) } : {}),
	};
}
