/** Translations: namespacing, the translation slot and coverage of every text a player sees. */
import { describe, expect, it } from 'vitest';
import { computeViews, createKernel, definePlugin, engineContext, PluginError, type PluginContext } from '../../src/kernel';
import { plugins } from '../../src/plugins';
import { wrap } from '../../src/plugins/world-map';
import type { HeroInfo } from '../../src/shared/api';
import { db, T0, defaultKernel, player, inner, outer } from '../helpers';

describe('translations (i18n)', () => {
	const words = (id: string, csv: string, more?: (ctx: PluginContext) => void) =>
		definePlugin({
			id,
			version: '0',
			dependsOn: ['i18n', 'resources'],
			setup(ctx) {
				ctx.services.get('i18n').addCsv(csv, ctx.pluginId);
				more?.(ctx);
			},
		});
	const table = (kernel: ReturnType<typeof createKernel>) => kernel.meta.get('i18n')!() as Record<string, Record<string, string>>;

	it('are namespaced by plugin: the same English word may mean different things in two plugins', () => {
		const kernel = createKernel([
			...plugins,
			words('test-academy', 'key,en,zh-CN,ja\nSchool,School,学堂,学校\n'),
			words('test-fishing', 'key,en,zh-CN\nSchool,School,鱼群\n'),
		]);
		const t = table(kernel);
		expect(t['zh-CN']['test-academy.School']).toBe('学堂');
		expect(t['zh-CN']['test-fishing.School']).toBe('鱼群');
		expect(t.en['test-fishing.School']).toBe('School');
		// Any plugin may add locales of its own.
		expect(t.ja).toEqual({ 'test-academy.School': '学校' });
		expect(t['zh-CN'].School).toBeUndefined();
	});

	it('refuse a key twice in one plugin, a missing English text, or a table without the en column', () => {
		expect(() => createKernel([...plugins, words('test-twice', 'key,en,zh-CN\nGate,Gate,门\nGate,Gate,城门\n')])).toThrow(PluginError);
		expect(() => createKernel([...plugins, words('test-no-en', 'key,en,zh-CN\nGate,,门\n')])).toThrow(/no English/);
		expect(() => createKernel([...plugins, words('test-old', 'key,zh-CN\nGate,门\n')])).toThrow(/key, en/);
	});

	it('make content names keys of the plugin defining them; only registered keys count as keys', () => {
		const kernel = createKernel([
			...plugins,
			words('test-salt', 'key,en,zh-CN\nSalt,Salt,盐\n', (ctx) =>
				ctx.services.get('resources').define({ id: 'test-salt', name: 'Salt', icon: '🧂', initial: 0 }),
			),
		]);
		const i18n = kernel.services.get('i18n');
		expect(
			kernel.services
				.get('resources')
				.list()
				.find((r) => r.id === 'test-salt')?.name,
		).toBe('test-salt.Salt');
		expect(i18n.isKey('test-salt.Salt')).toBe(true);
		expect(i18n.isKey('test-salt.Salt ×5')).toBe(false);
		expect(() => i18n.own('Salt')).toThrow(/outside a plugin's setup/);
	});

	it('cover every text a player sees: views, forms and meta translate into Chinese (a played-through account)', async () => {
		const kernel = defaultKernel;
		const tables = kernel.meta.get('i18n')!() as Record<string, Record<string, string>>;
		const keys = new Set(Object.values(tables).flatMap((m) => Object.keys(m)));
		const missing = new Set<string>();
		// Tech nodes a GM added at runtime (other tests leave some) are named as the GM wrote them.
		const authored = new Set(
			(await db.prepare('SELECT def FROM research_nodes').all<{ def: string }>()).results.map((r) => JSON.parse(r.def).name as string),
		);
		// Nothing to translate: placeholders, numbers, durations ("1m 30s"), rates ("+1/s"), heroes' name-part keys.
		const plain = (text: string) =>
			!/\p{L}/u.test(
				text
					.replace(/\{\w+\}/g, '')
					.replace(/\bs:[^\s,，]+ [mf]:[^\s,，]+/g, '')
					.replace(/\b\d+(\.\d+)?[dhms]\b/g, '')
					.replace(/\/[smh]\b/g, ''),
			);
		/** A key the client looks up: registered, and in Chinese unless there are no words in it. */
		const check = (text: string, where: string) => {
			if (!text || authored.has(text) || authored.has(text.slice(text.indexOf('.') + 1))) return;
			if (!keys.has(text)) {
				if (!plain(text.replace(/^[a-z][a-z0-9-]*\./, ''))) missing.add(`${text}  (not a key: ${where})`);
			} else if (!(text in tables['zh-CN']) && !plain(text.slice(text.indexOf('.') + 1))) missing.add(`${text}  (no Chinese: ${where})`);
		};
		/** A value inside a text: shown as it is, so no key and no words (a text goes in as a UiText). */
		const value = (v: string, where: string) => {
			if (keys.has(v)) missing.add(`${v}  (a key given as a value: ${where})`);
			else if (!plain(v) && !authored.has(v)) missing.add(`${v}  (words given as a value: ${where})`);
		};
		// Shown as text by the client: UiTexts, and these fields (names, labels...) as they are.
		const SHOWN = new Set([
			'name',
			'label',
			'title',
			'description',
			'source',
			'note',
			'attackerName',
			'set',
			'branch',
			'quote',
			'placeholder',
			'submitLabel',
			'confirm',
			'kindName',
		]);
		const walk = (v: unknown, where: string): void => {
			if (Array.isArray(v)) return v.forEach((x) => walk(x, where));
			if (!v || typeof v !== 'object') return;
			const o = v as Record<string, unknown>;
			if (typeof o.text === 'string' && Object.keys(o).every((k) => k === 'text' || k === 'vars')) {
				check(o.text, where);
				// literal(): a text a player typed, shown as written (so never a key).
				if (o.text === 'i18n.{0}') {
					const v = (o.vars as Record<string, unknown> | undefined)?.[0];
					if (typeof v === 'string' && keys.has(v)) missing.add(`${v}  (a key shown as written: ${where})`);
					return;
				}
				for (const x of Object.values((o.vars ?? {}) as Record<string, unknown>))
					typeof x === 'string' ? value(x, `${where}: ${o.text}`) : walk(x, where);
				return;
			}
			// A form field's name is its payload key, a hidden one shows nothing.
			if (o.type === 'hidden') return;
			const field = typeof o.name === 'string' && typeof o.type === 'string';
			// A text box shows its default as it is: an i18n key there would show (and be saved) untranslated.
			if (field && o.type === 'text' && typeof o.default === 'string' && keys.has(o.default))
				missing.add(`${o.default}  (${where}: default of the text field "${String(o.name)}")`);
			for (const [k, x] of Object.entries(o))
				typeof x === 'string' ? SHOWN.has(k) && !(field && k === 'name') && check(x, `${where}.${k}`) : walk(x, where);
		};

		// An account with a bit of everything: buildings, techs, every item, troops, a hero, a raid and an adventure.
		const p = player({ 'armies.minSeconds': 0, 'starter-realms.heroStats': { attack: 1e6, defense: 1e6, hp: 1e6 } });
		const c = await p.start();
		for (const r of kernel.services.get('resources').list()) await p.grant(T0, r.id, 1e7);
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		await p.construct(T0 + 1_000, c.id, outer(c).id, 0, 'farm');
		for (const tech of ['agriculture', 'art-of-war', 'masonry']) await p.run(T0, 'research.setLevel', { tech, level: 2 }, true);
		for (const item of kernel.services.get('items').list()) await p.run(T0, 'items.grant', { item: item.id, count: 2 }, true);
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'cavalry-6', count: 500 }, true);
		const at = T0 + 3_600_000;
		await p.run(at, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		const [hero] = (await p.views(at, ['heroes.list']))['heroes.list'] as HeroInfo[];
		await p.construct(at, c.id, inner(c).id, 1, 'barracks');
		await p.construct(at, c.id, inner(c).id, 2, 'institute');
		const camp = { x: wrap(c.x + 3), y: c.y };
		await p.run(at, 'npc-camps.spawnAt', { kind: 'npc-fortress', ...camp, level: 3 }, true);
		await p.run(at, 'armies.send', { from: c.id, ...camp, units: { 'cavalry-6': 100 } });
		await p.run(at, 'realms.adventure', { hero: hero.id, realm: 'black-wind', task: 0 });
		const now = at + 7_200_000;
		const params: Record<string, string> = { settlement: c.id, x: String(c.x), y: String(c.y), r: '3', hero: hero.id };
		const allViews = async (t: number, when: string) => {
			for (const view of kernel.views) {
				if (view.id === 'ui.forms') continue;
				const shown = await p.views(t, [view.id], params).catch(() => null);
				if (shown) walk(shown[view.id], `${view.id} (${when})`);
			}
		};
		// While the army marches and the hero is away, then after both are back.
		await allViews(at + 1_000, 'under way');
		await p.run(now, 'realms.sync');
		await p.run(now, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		await allViews(now, 'done');
		const contexts: Record<string, string>[] = [
			{ placement: 'items', settlement: c.id },
			{ placement: 'tile', ...camp, x: String(camp.x), y: String(camp.y) },
			{ placement: 'tile', x: String(c.x), y: String(c.y) },
			{ placement: 'hero', hero: hero.id },
			{ placement: 'settlement', settlement: c.id },
			{ placement: 'global' },
			...kernel.services
				.get('buildings')
				.list()
				.map((b) => ({ placement: 'building', settlement: c.id, type: b.id })),
		];
		for (const ctx of contexts)
			walk((await p.views(now, ['ui.forms'], ctx))['ui.forms'], `ui.forms(${ctx.placement}${ctx.type ? `:${ctx.type}` : ''})`);
		// The GM's forms for this player (GM console).
		const asGm = engineContext(kernel, p.id, now, {}, true);
		walk((await computeViews(kernel, db, asGm, ['ui.forms'], { placement: 'gm', settlement: c.id })).views['ui.forms'], 'ui.forms(gm)');
		for (const [id, provide] of kernel.meta) if (id !== 'i18n' && id !== 'heroNames') walk(await provide(), `meta.${id}`);
		expect([...missing].sort()).toEqual([]);
	}, 30_000); // every view twice, every form placement: slow on CI runners

	it("about another plugin's entity come from that plugin: a missing hero is always heroes' own error", async () => {
		const p = player();
		await p.start();
		for (const [type, payload] of [
			['realms.heal', { hero: 'no-such-hero' }],
			['realms.adventure', { hero: 'no-such-hero', realm: 'black-wind', task: 0 }],
			['heroes.dismiss', { hero: 'no-such-hero' }],
		] as const)
			await expect(p.run(T0, type, payload)).rejects.toMatchObject({ code: 'not_found', message: 'No such hero', owner: 'heroes' });
	});

	it('have a slot for injected translations: a community plugin adds a locale or corrects a text, without touching the official ones', () => {
		const community = definePlugin({
			id: 'test-community',
			version: '0',
			dependsOn: ['i18n'],
			setup: (ctx) => ctx.services.get('i18n').inject('key,zh-TW,zh-CN\nstarter-content.Farm,農田,\nstarter-content.Palace,,王宫\n'),
		});
		const t = table(createKernel([...plugins, community]));
		expect(t['zh-TW']['starter-content.Farm']).toBe('農田');
		expect(t['zh-CN']['starter-content.Palace']).toBe('王宫');
		expect(t['zh-CN']['starter-content.Farm']).toBe('农田');
		// Two injections that disagree are refused; agreeing ones are fine.
		const another = (id: string, text: string) =>
			definePlugin({
				id,
				version: '0',
				dependsOn: ['i18n'],
				setup: (ctx) => ctx.services.get('i18n').inject(`key,zh-TW\nstarter-content.Farm,${text}\n`),
			});
		expect(() => createKernel([...plugins, community, another('test-same', '農田')])).not.toThrow();
		expect(() => createKernel([...plugins, community, another('test-other', '田地')])).toThrow(/disagree/);
	});
});
