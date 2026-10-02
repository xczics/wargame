/**
 * Server-driven forms. Any command can carry a `form` (see `CommandForm` in the kernel);
 * this plugin lists the ones available right now so the client's generic forms plugin can
 * render them — simple features then need no frontend code of their own.
 *
 * view `ui.forms` — params: `placement` (required) plus context such as `settlement`, `x`, `y`.
 *
 * A form's texts are i18n keys of the command's plugin (titles, labels, options...); ones already
 * prefixed with a plugin's id (content names, texts a service added for another plugin) stay as they are.
 */
import { definePlugin, GameError, mapFormTexts } from '../../kernel';
import type { FormField, ResolvedForm } from '../../shared/api';
import i18nCsv from './data/i18n.csv?raw';

export default definePlugin({
	id: 'forms',
	version: '0.1.0',
	description: 'Lists command forms available to the player (rendered by the generic client)',
	dependsOn: ['ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const i18n = ctx.services.get('i18n');
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
					const own = (text: string) => (text && !i18n.isKey(text) ? `${command.owner}.${text}` : text);
					const description = patch.description ?? spec.description;
					out.push({
						...mapFormTexts({ ...spec, ...(description ? { description } : {}), fields, ...(budgets.length ? { budgets } : {}) }, own),
						command: command.type,
						owner: command.owner,
					});
				}
				return out;
			},
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.block({ page: '*', column: 'left', widget: 'forms.outlet', order: -90 });
		ui.entry({ kind: 'building', widget: 'forms.entry' });
	},
});
