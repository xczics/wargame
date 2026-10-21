/**
 * A form as shown: its fixed part (static `forms.specs`) with what `prepare` sent now (view `forms.patches`). Done in
 * the browser (AGENTS.md: data and display apart): `prepare` sends data (ids, numbers, names), and the words around them
 * are made here, by the generic rules below (`count`, `at`, `index`, `atMost`) and by the client parts of the plugins that
 * own the forms (`FormPart`, extension point "forms.prepare", keyed as `FormPatch.data`). The tests and the GM console
 * go by the same function.
 */
import type { ClientViewGet } from './client-views';
import type { FormField, FormOption, FormPart, FormPatch, FormPatches, FormSpecs, ResolvedForm } from './api';
import { whole } from './format';
import { uiTexts } from './i18n';

// The forms plugin's words (its i18n keys) for the generic rules.
const text = uiTexts('forms');

/** What resolving reads: the static specs and meta, and the parts client plugins add at "forms.prepare". */
export type FormsInput = Pick<ClientViewGet, 'static' | 'meta' | 'parts'>;

const atMost = (n: number) => text('At most {0}', { 0: whole(n) });

/** The generic words of a field: "label (n)", the label's {0} = its index ("Hero 2"), "At most n". */
function worded(f: FormField): FormField {
	const { count, index, atMost: most, atMostBy, ...rest } = f;
	let label = rest.label;
	if (count !== undefined) label = text('{0} ({1})', { 0: label, 1: whole(count) });
	if (index !== undefined) label = { ...label, vars: { ...label.vars, 0: index } };
	return {
		...rest,
		label,
		...(most !== undefined ? { placeholder: atMost(most) } : {}),
		...(atMostBy
			? {
					placeholderBy: {
						field: atMostBy.field,
						values: Object.fromEntries(Object.entries(atMostBy.values).map(([k, n]) => [k, atMost(n)])),
					},
				}
			: {}),
		...(rest.options ? { options: rest.options.map(option) } : {}),
	};
}
function option(o: FormOption): FormOption {
	const { count, at, ...rest } = o;
	if (count !== undefined) return { ...rest, label: text('{0} ({1})', { 0: rest.label, 1: whole(count) }) };
	if (at) return { ...rest, label: text('{0} ({1}, {2})', { 0: rest.label, 1: at.x, 2: at.y }) };
	return rest;
}

/** The patch with its data worded by the parts that own it; false: a part hid the form, or none is there to word it. */
function applyParts(command: string, raw: FormPatch, input: FormsInput, parts: ReadonlyMap<string, FormPart>): FormPatch | false {
	if (!raw.data) return raw;
	const { data, ...rest } = raw;
	let patch: FormPatch = rest;
	for (const [id, d] of Object.entries(data)) {
		const part = parts.get(id);
		if (!part) return false;
		const next = part(d, { command, patch, meta: input.meta, static: input.static });
		if (next === false) return false;
		patch = next;
	}
	return patch;
}

export function resolveForms(input: FormsInput, data: FormPatches | null | undefined): ResolvedForm[] | undefined {
	const specs = input.static<FormSpecs>('forms.specs');
	if (!specs || !data) return undefined;
	const parts = input.parts<FormPart>('forms.prepare');
	return data.forms.flatMap(({ command, patch: raw = {} }) => {
		const spec = specs[command];
		if (!spec) return [];
		const patch = applyParts(command, raw, input, parts);
		if (patch === false) return [];
		const fields: FormField[] = [...spec.fields, ...(patch.fields ?? [])].map((f) =>
			worded({
				...f,
				...(patch.defaults && f.name in patch.defaults ? { default: patch.defaults[f.name] } : {}),
				...(patch.options?.[f.name] ? { options: patch.options[f.name] } : {}),
				...(patch.placeholderBy?.[f.name] ? { placeholderBy: patch.placeholderBy[f.name] } : {}),
				...(patch.atMostBy?.[f.name] ? { atMostBy: patch.atMostBy[f.name] } : {}),
			}),
		);
		const budgets = [...(spec.budgets ?? []), ...(patch.budgets ?? [])];
		const description = patch.description ?? spec.description;
		const columns = patch.columns ?? spec.columns;
		const { description: _d, columns: _c, budgets: _b, ...rest } = spec;
		return [
			{
				...rest,
				...(description ? { description } : {}),
				fields,
				...(budgets.length ? { budgets } : {}),
				...(columns ? { columns } : {}),
			},
		];
	});
}
