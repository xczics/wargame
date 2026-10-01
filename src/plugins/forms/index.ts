/**
 * Server-driven forms. Any command can carry a `form` (see `CommandForm` in the kernel);
 * this plugin lists the ones available right now so the client's generic forms plugin can
 * render them — simple features then need no frontend code of their own.
 *
 * view `ui.forms` — params: `placement` (required) plus context such as `settlement`, `x`, `y`.
 */
import { definePlugin, GameError } from '../../kernel';
import type { FormField, ResolvedForm } from '../../shared/api';

export default definePlugin({
	id: 'forms',
	version: '0.1.0',
	description: 'Lists command forms available to the player (rendered by the generic client)',
	setup(ctx) {
		ctx.views.add({
			id: 'ui.forms',
			async compute(api, params): Promise<ResolvedForm[]> {
				const placement = params.placement;
				if (!placement) return [];
				const out: ResolvedForm[] = [];
				for (const command of ctx.commands.all().values()) {
					const form = command.form;
					if (!form || form.placement !== placement || (command.privileged && !api.privileged)) continue;
					let patch;
					try {
						patch = form.prepare ? await form.prepare(api, params) : {};
					} catch (err) {
						// A form whose context is invalid (e.g. someone else's settlement) is simply not offered.
						if (err instanceof GameError) continue;
						throw err;
					}
					if (patch === false) continue;
					const fields: FormField[] = [...form.fields, ...(patch.fields ?? [])].map((f) => ({
						...f,
						...(patch.defaults && f.name in patch.defaults ? { default: patch.defaults[f.name] } : {}),
						...(patch.options?.[f.name] ? { options: patch.options[f.name] } : {}),
					}));
					const { prepare: _, ...spec } = form;
					const budgets = [...(spec.budgets ?? []), ...(patch.budgets ?? [])];
					out.push({
						...spec,
						description: patch.description ?? spec.description,
						fields,
						...(budgets.length ? { budgets } : {}),
						command: command.type,
						owner: command.owner,
					});
				}
				return out;
			},
		});
	},
});
