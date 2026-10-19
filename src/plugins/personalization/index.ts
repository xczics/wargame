/**
 * Personalization: how the site looks that is the GM's to choose at runtime — its icon (a built-in one or an uploaded
 * picture) and its title, and whatever other plugins register (`personalization.add`). Nothing here knows the game: any
 * project built on the kernel can take this plugin as it is.
 *
 * Every field is a GM rule of the plugin that registers it (its description and translations are that plugin's), so
 * changing one is an ordinary rule change: audited, the rules' version moves on. Browsers get the values from the static
 * view `personalization.site` (fetched once per version, kept), never in the syncs; the client plugin "personalization"
 * applies them (the tab's icon and title) and remembers them for the next visit's login screen.
 *
 * Built-in icons are static files (public/icons/<id>.svg, the default also public/favicon.svg and favicon.ico), served
 * without the Worker. Uploads go to the file bucket under their hash (`personalization/<hash>.<type>`, routes below);
 * an SVG is refused when it has anything but drawing in it (`unsafeSvg`), and served sandboxed through the Worker.
 */
import { type ConfigHandle, csvRows, definePlugin, gameErrors, loadConfig, PluginError } from '../../kernel';
import { json } from '../../lib/http';
import { imageName, imageResponse, putImage, sniffImage, unsafeSvg } from '../../runtime/files';
import type { PersonalizationGmData, PersonalizationSite, PersonalizationValue } from '../../shared/api';
import { keyText, uiTexts } from '../../shared/i18n';
import i18nCsv from './data/i18n.csv?raw';
import iconsCsv from './data/icons.csv?raw';

const fail = gameErrors('personalization');
const text = uiTexts('personalization');

const MAX_IMAGE = 256 * 1024;
const MAX_TITLE = 60;
const PREFIX = 'personalization';
const TYPES = ['png', 'svg', 'webp', 'ico'] as const;
const NAME = imageName(TYPES);
const UPLOADED = new RegExp(`^${PREFIX}/${NAME.source.slice(1)}`);

/** A built-in picture to choose from: a static file of the site. */
export interface PersonalizationChoice {
	id: string;
	/** An i18n key of the registering plugin. */
	name: string;
	/** Its site path ("/icons/keep.svg"). */
	url: string;
}

export interface PersonalizationField {
	/**
	 * The rule holding the value, defined by the registering plugin (`ctx.config.define`, with `parse: personalization.parser(…)`).
	 * Image: a choice's id or an uploaded picture's key; text: the text.
	 */
	rule: ConfigHandle<string>;
	/** An i18n key of the registering plugin. */
	label: string;
	kind: 'image' | 'text';
	/** Image fields: the built-in pictures. */
	choices?: PersonalizationChoice[];
	/** Text fields: the longest text. */
	max?: number;
}

export interface PersonalizationService {
	/** Show a field on the GM's personalization tab and send its value to browsers (static view `personalization.site`). */
	add(field: PersonalizationField): void;
	/** More built-in pictures for an image field (by its rule's key), e.g. from a content pack. */
	addChoices(key: string, choices: PersonalizationChoice[]): void;
	/**
	 * A strict `parse` for a field's rule: image = one of the field's choices (by its rule's key) or an uploaded
	 * picture's key; text = at most `max` characters.
	 */
	parser(kind: 'image', key: string): (raw: unknown) => string;
	parser(kind: 'text', max: number): (raw: unknown) => string;
}

declare module '../../kernel' {
	interface ServiceMap {
		personalization: PersonalizationService;
	}
}

export default definePlugin({
	id: 'personalization',
	version: '0.1.0',
	description: "Personalization: the site's icon, title and other looks the GM chooses",
	dependsOn: ['accounts', 'gm', 'ui', 'i18n'],
	setup(ctx) {
		const i18n = ctx.services.get('i18n');
		i18n.addCsv(i18nCsv, ctx.pluginId);
		const fields = new Map<string, PersonalizationField & { choices: PersonalizationChoice[] }>();
		const choicesOf = (key: string) => fields.get(key)?.choices ?? [];

		function parser(kind: 'image' | 'text', arg: string | number) {
			if (kind === 'text')
				return (raw: unknown) => {
					if (typeof raw !== 'string') throw fail('bad_config', 'Expected text');
					const value = raw.trim();
					if (value.length > Number(arg)) throw fail('bad_config', text('At most {0} characters', { 0: Number(arg) }));
					return value;
				};
			return (raw: unknown) => {
				if (typeof raw === 'string' && (UPLOADED.test(raw) || choicesOf(String(arg)).some((c) => c.id === raw))) return raw;
				throw fail(
					'bad_config',
					text('Unknown icon "{0}" (built in: {1}; or upload one)', {
						0: typeof raw === 'string' ? raw.slice(0, 80) : typeof raw,
						1: choicesOf(String(arg))
							.map((c) => c.id)
							.join(', '),
					}),
				);
			};
		}
		const service: PersonalizationService = {
			add(field) {
				if (fields.has(field.rule.key)) throw new PluginError(`Personalization field "${field.rule.key}" added twice`);
				const own = i18n.scope();
				fields.set(field.rule.key, {
					...field,
					label: own(field.label),
					choices: (field.choices ?? []).map((c) => ({ ...c, name: own(c.name) })),
				});
			},
			addChoices(key, choices) {
				const field = fields.get(key);
				if (!field || field.kind !== 'image') throw new PluginError(`No personalization picture field "${key}"`);
				const own = i18n.scope();
				field.choices.push(...choices.map((c) => ({ ...c, name: own(c.name) })));
			},
			parser: parser as PersonalizationService['parser'],
		};
		ctx.services.provide('personalization', service);

		/* ----- this plugin's own fields: the icon and the title ------------------------------------- */

		const icons = csvRows(iconsCsv).map((r) => ({ id: r.id, name: r.name, url: `/icons/${r.id}.svg` }));
		if (!icons.length) throw new PluginError('personalization: data/icons.csv lists no icon');
		const icon = ctx.config.define('icon', {
			description: 'The site icon: a built-in icon id, or the key of an uploaded picture',
			default: () => icons[0].id,
			parse: parser('image', `${ctx.pluginId}.icon`),
		});
		service.add({ rule: icon, label: 'Site icon', kind: 'image', choices: icons });
		const title = ctx.config.define('title', {
			description: "The site's title in the browser tab (empty: the game's own)",
			default: () => '',
			parse: parser('text', MAX_TITLE),
		});
		service.add({ rule: title, label: 'Site title', kind: 'text', max: MAX_TITLE });

		/* ----- browsers: every value, by rules version ----------------------------------------------- */

		ctx.statics.add({
			id: 'personalization.site',
			compute({ rules }) {
				const out: PersonalizationSite = {};
				for (const [key, f] of fields) {
					const value = f.rule.get(rules);
					out[key] = ((): PersonalizationValue => {
						if (f.kind === 'text') return { text: value };
						if (UPLOADED.test(value)) return { file: value };
						return { url: (f.choices.find((c) => c.id === value) ?? f.choices[0]).url };
					})();
				}
				return out;
			},
		});

		/* ----- the GM's tab --------------------------------------------------------------------------- */

		const accounts = ctx.services.get('accounts');
		ctx.routes.add({
			method: 'GET',
			path: '/api/gm/personalization',
			async handler({ kernel, request, env }) {
				await accounts.requireGM(request, env);
				const [{ values }, { overrides }] = await Promise.all([loadConfig(kernel, env), ctx.services.get('configStore').load(env)]);
				const listed = env.FILES ? await env.FILES.list({ prefix: `${PREFIX}/`, limit: 200 }) : null;
				const uploads = (listed?.objects ?? [])
					.filter((o) => UPLOADED.test(o.key))
					.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime())
					.map((o) => o.key);
				return json({
					fields: [...fields.values()].map((f) => ({
						key: f.rule.key,
						label: keyText(f.label),
						kind: f.kind,
						choices: f.choices.map((c) => ({ id: c.id, name: keyText(c.name), url: c.url })),
						value: f.rule.get({ config: values }),
						default: kernel.config.get(f.rule.key)!.def.default({ config: values }) as string,
						overridden: f.rule.key in overrides,
						...(f.max ? { max: f.max } : {}),
					})),
					uploads,
					canUpload: !!env.FILES,
					maxImage: MAX_IMAGE,
				} satisfies PersonalizationGmData);
			},
		});
		// Pictures as they are (no CPU for images here): checked by their bytes, an SVG by what is in it, stored under their hash.
		ctx.routes.add({
			method: 'POST',
			path: '/api/gm/personalization/image',
			async handler({ request, env }) {
				const gm = await accounts.requireGM(request, env);
				if (!env.FILES) throw fail('no_storage', 'No file bucket here');
				const bytes = new Uint8Array(await request.arrayBuffer());
				if (!bytes.length || bytes.length > MAX_IMAGE)
					throw fail('bad_payload', text('A picture of at most {0} KB', { 0: MAX_IMAGE / 1024 }));
				const type = sniffImage(bytes, TYPES);
				if (!type) throw fail('bad_payload', 'Only PNG, SVG, WebP or ICO pictures');
				if (type === 'svg' && unsafeSvg(bytes))
					throw fail('bad_payload', 'This SVG has scripts, links or other active content: only plain drawings');
				const key = await putImage(env.FILES, PREFIX, bytes, type);
				await ctx.services.get('gmAudit').record(env, gm.username, 'personalization.image', { key, bytes: bytes.length });
				return json({ key });
			},
		});
		// Uploaded pictures when the bucket has no public URL: for everyone (the login screen shows the icon too), kept for good.
		ctx.routes.add({
			method: 'GET',
			path: `/api/files/${PREFIX}/:name`,
			async handler({ env, params }) {
				const file = NAME.test(params.name) ? await env.FILES?.get(`${PREFIX}/${params.name}`) : null;
				if (!file) return new Response('no such picture', { status: 404 });
				return imageResponse(file, 'public, max-age=31536000, immutable');
			},
		});

		ctx.services.get('ui').slot({ slot: 'gm-tabs', widget: 'personalization.gm', props: { label: text('Personalization') } });
	},
});
