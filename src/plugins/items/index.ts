/**
 * Items: a per-player inventory, and a generic way to make items usable.
 *
 * A usable item declares `use` (payload parsing, the effect, and a form). The items plugin
 * turns it into a command `items.use.<id>` whose form only shows while the player owns
 * one; using it consumes one in the same atomic commit as the effect, so a failed effect
 * never costs the item.
 */
import { type CommandForm, definePlugin, type EngineApi, fields, gameErrors, PluginError, type ReadApi, shape } from '../../kernel';
import type { ItemStack } from '../../shared/api';
import type { CardsData } from '../../shared/ui';
import i18nCsv from './data/i18n.csv?raw';
import { keyText, uiTexts } from '../../shared/i18n';

const fail = gameErrors('items');
const text = uiTexts('items');

export interface ItemUse<P> {
	parse(raw: unknown): P;
	apply(api: EngineApi, payload: P): Promise<void>;
	/** Form for the generic client (placement defaults to "items"). Hidden while the player has none. */
	form: Omit<CommandForm, 'placement'> & { placement?: string };
}

export interface ItemDef<P = unknown> {
	id: string;
	name: string;
	icon?: string;
	description?: string;
	/** Group on the Items page, e.g. "resources", "heroes" (default "misc"). */
	category?: string;
	/** Colours the name (equipment rarity, e.g. a chest of gold pieces). */
	rarity?: string;
	/**
	 * Other places that show a button for this item (besides the Items page): "building:<type>"
	 * (that building's entry) or "page:<id>". With the item: confirm and use it there; without:
	 * where it can be had (`addSource`).
	 */
	shortcuts?: string[];
	use?: ItemUse<P>;
}

export interface ItemsService {
	define<P>(def: ItemDef<P>): void;
	list(): readonly ItemDef[];
	/** Where players can get an item, for "you have none" hints, e.g. "shop", "realms". */
	addSource(item: string, source: string): void;
	count(api: ReadApi, playerId: string, item: string): Promise<number>;
	grant(api: EngineApi, playerId: string, item: string, n: number): Promise<void>;
	/** Remove `n`, or throw `GameError` if the player has fewer. */
	consume(api: EngineApi, playerId: string, item: string, n: number): Promise<void>;
}

declare module '../../kernel' {
	interface ServiceMap {
		items: ItemsService;
	}
}

export default definePlugin({
	id: 'items',
	version: '0.1.0',
	description: 'Player inventory; usable items become commands with generic forms',
	dependsOn: ['ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const defs = new Map<string, ItemDef>();
		const sources = new Map<string, string[]>();

		const inventory = (api: ReadApi, playerId: string) =>
			api.memo(`items:inventory:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT item, count FROM items_inventory WHERE player_id = ?')
					.bind(playerId)
					.all<{ item: string; count: number }>();
				return new Map(results.map((r) => [r.item, r.count]));
			});
		const store = async (api: EngineApi, playerId: string, item: string, count: number) => {
			(await inventory(api, playerId)).set(item, count);
			api.write(
				api.db
					.prepare(
						'INSERT INTO items_inventory (player_id, item, count) VALUES (?, ?, ?) ON CONFLICT (player_id, item) DO UPDATE SET count = excluded.count',
					)
					.bind(playerId, item, count),
			);
		};
		const known = (id: string) => {
			const def = defs.get(id);
			if (!def) throw fail('unknown_item', text('Unknown item "{0}"', { 0: id }));
			return def;
		};

		const categoryLabels = new Map<string, string>();
		const service: ItemsService = {
			define(def) {
				if (defs.has(def.id)) throw new PluginError(`Item "${def.id}" defined twice`);
				// Texts are i18n keys of the plugin defining the item (also its form's, now and from `prepare`).
				const own = ctx.services.get('i18n').scope();
				def = { ...def, name: own(def.name), ...(def.description ? { description: own(def.description) } : {}) };
				defs.set(def.id, def as ItemDef);
				// A category's label: ours if we have one, else that of the first plugin using it.
				const category = def.category ?? 'misc';
				const i18n = ctx.services.get('i18n');
				if (!categoryLabels.has(category))
					categoryLabels.set(
						category,
						i18n.isKey(`items.item-category:${category}`) ? `items.item-category:${category}` : own(`item-category:${category}`),
					);
				const use = def.use;
				if (!use) return;
				const { prepare, placement = 'items', ...form } = use.form;
				ctx.commands.add({
					type: `items.use.${def.id}`,
					description: `Use ${def.name}${def.description ? `: ${def.description}` : ''}`,
					parse: (raw) => use.parse(raw),
					async execute(api, payload) {
						await service.consume(api, api.playerId, def.id, 1);
						await use.apply(api, payload);
					},
					form: {
						...form,
						placement,
						async prepare(api, params) {
							const have = await service.count(api, api.playerId, def.id);
							if (have < 1) return false;
							const raw = prepare ? await prepare(api, params) : {};
							if (raw === false) return false;
							// "<its description> (you have 3)": the item's text inside ours.
							const desc = raw.description ?? (def.description ? keyText(def.description) : undefined);
							return { ...raw, description: desc ? text('{0} (you have {1})', { 0: desc, 1: have }) : text('(you have {0})', { 0: have }) };
						},
					},
				});
			},
			list: () => [...defs.values()],
			addSource(item, source) {
				const list = sources.get(item) ?? [];
				if (!list.includes(source)) list.push(source);
				sources.set(item, list);
			},
			async count(api, playerId, item) {
				return (await inventory(api, playerId)).get(item) ?? 0;
			},
			async grant(api, playerId, item, n) {
				known(item);
				await store(api, playerId, item, (await service.count(api, playerId, item)) + n);
			},
			async consume(api, playerId, item, n) {
				const def = known(item);
				const have = await service.count(api, playerId, item);
				if (have < n) throw fail('no_item', text('You have no {0}', { 0: keyText(def.name) }));
				await store(api, playerId, item, have - n);
			},
		};
		ctx.services.provide('items', service);

		ctx.meta.add('items', () =>
			service.list().map(({ id, name, icon, description, shortcuts, use }) => ({
				id,
				name,
				icon,
				description,
				usable: !!use,
				shortcuts: shortcuts ?? [],
				sources: sources.get(id) ?? [],
			})),
		);
		ctx.views.add({
			id: 'items.inventory',
			async compute(api): Promise<ItemStack[]> {
				const inv = await inventory(api, api.playerId);
				return service
					.list()
					.filter((d) => (inv.get(d.id) ?? 0) > 0)
					.map((d) => ({
						id: d.id,
						name: d.name,
						icon: d.icon,
						description: d.description,
						category: d.category ?? 'misc',
						count: inv.get(d.id)!,
						usable: !!d.use,
					}));
			},
		});

		// The Items page with the generic widgets: categories (ui.filters), owned items as tiles (ui.cards);
		// opening one shows its description and use form.
		ctx.views.add({
			id: 'items.cards',
			async compute(api): Promise<CardsData> {
				const inv = await inventory(api, api.playerId);
				const owned = service.list().filter((d) => (inv.get(d.id) ?? 0) > 0);
				return {
					title: text('Items'),
					allTitle: text('All items'),
					groups: [...new Set(owned.map((d) => d.category ?? 'misc'))].map((c) => ({ id: c, label: keyText(categoryLabels.get(c)!) })),
					cards: owned.map((d) => ({
						id: d.id,
						group: d.category ?? 'misc',
						...(d.icon ? { icon: d.icon } : {}),
						title: keyText(d.name),
						...(d.rarity ? { rarity: d.rarity } : {}),
						count: inv.get(d.id)!,
						...(d.description ? { text: keyText(d.description) } : {}),
						detail: d.use
							? {
									lines: [text('Usable items apply to the selected settlement.')],
									form: { placement: 'items', command: `items.use.${d.id}` },
								}
							: { lines: [text('This item is not used from here.')] },
					})),
					empty: text('Your inventory is empty.'),
				};
			},
		});

		// Items that asked for a button elsewhere (their `shortcuts`), for the compact cards widget: owned,
		// its use form opens in place; not owned, where to get it.
		ctx.views.add({
			id: 'items.shortcuts',
			async compute(api): Promise<CardsData> {
				const inv = await inventory(api, api.playerId);
				return {
					cards: service.list().flatMap((d) =>
						d.use
							? (d.shortcuts ?? []).map((where) => {
									const n = inv.get(d.id) ?? 0;
									const from = sources.get(d.id) ?? [];
									return {
										id: `${d.id}@${where}`,
										where,
										...(d.icon ? { icon: d.icon } : {}),
										title: keyText(d.name),
										...(d.rarity ? { rarity: d.rarity } : {}),
										count: n,
										...(d.description ? { text: keyText(d.description) } : {}),
										detail: n
											? { form: { placement: 'items', command: `items.use.${d.id}` } }
											: {
													lines: [
														text('You have none.'),
														...(from.includes('realms') ? [text('It can be found on realm adventures.')] : []),
													],
												},
										...(n || !from.includes('shop') ? {} : { actions: [{ page: 'shop', label: text('Buy it in the shop') }] }),
									};
								})
							: [],
					),
				};
			},
		});

		ctx.commands.add<{ item: string; count: number }>({
			type: 'items.grant',
			form: {
				title: text('Give items'),
				placement: 'gm',
				fields: [
					{ name: 'item', label: text('Item'), type: 'select', required: true },
					{ name: 'count', label: text('Count (negative to take)'), type: 'number', required: true, default: 1 },
				],
				submitLabel: text('Give'),
				async prepare(api) {
					const inv = await inventory(api, api.playerId);
					return {
						options: {
							item: service.list().map((d) => ({ value: d.id, label: text('{0} ({1})', { 0: keyText(d.name), 1: inv.get(d.id) ?? 0 }) })),
						},
					};
				},
			},
			privileged: true,
			description: 'Give items to the player (negative to take). Payload: { "item": "expansion-permit", "count": 1 }',
			parse: shape({ item: fields.oneOf(() => [...defs.keys()]), count: fields.orElse(fields.int(-1e6, 1e6), 1) }),
			async execute(api, { item, count }) {
				if (count >= 0) await service.grant(api, api.playerId, item, count);
				else await service.consume(api, api.playerId, item, Math.min(-count, await service.count(api, api.playerId, item)));
			},
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.page({ id: 'items', label: 'Items', order: 8 });
		ui.block({ page: 'items', column: 'left', widget: 'ui.filters', props: { view: 'items.cards', filter: 'items' } });
		ui.block({ page: 'items', column: 'right', widget: 'ui.cards', props: { view: 'items.cards', filter: 'items', layout: 'tiles' } });
		// Items with a button elsewhere (their `shortcuts`): on those building entries and pages.
		ui.dynamic(() => {
			const places = new Set(service.list().flatMap((i) => i.shortcuts ?? []));
			const buildings = [...places].filter((p) => p.startsWith('building:')).map((p) => p.slice('building:'.length));
			return {
				entries: buildings.length
					? [{ kind: 'building', widget: 'ui.cards', order: 50, types: buildings, props: { view: 'items.shortcuts', layout: 'compact' } }]
					: [],
				blocks: [...places]
					.filter((p) => p.startsWith('page:'))
					.map((p) => ({
						page: p.slice('page:'.length),
						column: 'left' as const,
						widget: 'ui.cards',
						order: 90,
						props: { view: 'items.shortcuts', layout: 'compact' },
					})),
			};
		});
	},
});
