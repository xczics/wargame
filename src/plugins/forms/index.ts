/**
 * Server-driven forms. Any command can carry a `form` (see `CommandForm` in the kernel);
 * this plugin lists the ones available right now so the client's generic forms plugin can
 * render them — simple features then need no frontend code of their own.
 *
 * Its fixed part is the static view `forms.specs`; view `forms.patches` (params: `placement`, required, plus context
 * such as `settlement`, `x`, `y`) says which are available now and what `prepare` adds; the browser puts them together
 * (view `ui.forms`, src/shared/forms.ts). A form's texts (titles, labels, options...) are UiTexts of the plugins
 * that wrote them.
 */
import { definePlugin, GameError, playerStamp } from '../../kernel';
import type { FormPatches, FormSpecs } from '../../shared/api';
import i18nCsv from './data/i18n.csv?raw';

export default definePlugin({
	id: 'forms',
	version: '0.1.0',
	description: 'Lists command forms available to the player (rendered by the generic client)',
	dependsOn: ['ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		// Each command form's fixed part, made at deploy / a GM rule change and sent through R2 (AGENTS.md: data and display
		// apart): the browser puts it together with what `prepare` adds now (`forms.patches`), src/shared/forms.ts.
		ctx.statics.add({
			id: 'forms.specs',
			compute: (): FormSpecs =>
				Object.fromEntries(
					[...ctx.commands.all().values()].flatMap((command) => {
						if (!command.form) return [];
						const { prepare: _, fixed, ...spec } = command.form;
						const known = fixed?.();
						const fields = [...spec.fields, ...(known?.fields ?? [])].map((f) =>
							known?.options?.[f.name] ? { ...f, options: known.options[f.name] } : f,
						);
						return [[command.type, { ...spec, fields, command: command.type, owner: command.owner }]];
					}),
				),
		});
		ctx.views.add({
			id: 'forms.patches',
			// Only the player's commits (and the rules) change what `prepare` finds, except around a map tile, where others
			// come and go: there at most a minute old.
			stamp: async (api, params) => `${await playerStamp(api)}${params.placement === 'tile' ? `|${Math.floor(api.now / 60_000)}` : ''}`,
			async compute(api, params): Promise<FormPatches> {
				const placement = params.placement;
				if (!placement) return { forms: [] };
				const forms: FormPatches['forms'] = [];
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
					forms.push({ command: command.type, ...(Object.keys(patch).length ? { patch } : {}) });
				}
				return { forms };
			},
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.block({ page: '*', column: 'left', widget: 'forms.outlet', order: -90 });
		ui.entry({ kind: 'building', widget: 'forms.entry' });
	},
});
