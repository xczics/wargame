/**
 * A form as shown: its fixed part (static `forms.specs`) with what `prepare` added now (view `forms.patches`). Done in
 * the browser (AGENTS.md: data and display apart); the tests and the GM console go by the same function.
 */
import type { FormField, FormPatches, FormSpecs, ResolvedForm } from './api';

export function resolveForms(specs: FormSpecs | undefined, data: FormPatches | null | undefined): ResolvedForm[] | undefined {
	if (!specs || !data) return undefined;
	return data.forms.flatMap(({ command, patch = {} }) => {
		const spec = specs[command];
		if (!spec) return [];
		const fields: FormField[] = [...spec.fields, ...(patch.fields ?? [])].map((f) => ({
			...f,
			...(patch.defaults && f.name in patch.defaults ? { default: patch.defaults[f.name] } : {}),
			...(patch.options?.[f.name] ? { options: patch.options[f.name] } : {}),
			...(patch.placeholderBy?.[f.name] ? { placeholderBy: patch.placeholderBy[f.name] } : {}),
		}));
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
