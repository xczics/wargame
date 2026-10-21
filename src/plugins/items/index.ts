/**
 * Items: a per-player inventory, and a generic way to make items usable.
 *
 * A usable item declares `use` (payload parsing, the effect, and a form). The items plugin
 * turns it into a command `items.use.<id>` whose form only shows while the player owns
 * one; using it consumes one in the same atomic commit as the effect, so a failed effect
 * never costs the item.
 */
import {
	type CommandForm,
	definePlugin,
	type EngineApi,
	fields,
	gameErrors,
	playerStamp,
	PluginError,
	type ReadApi,
	shape,
} from '../../kernel';
import type { ItemCatalog, ItemsExtra, ItemUseFormData, OddsData } from '../../shared/api';
import { oddsText } from '../../shared/items';
import type { CardsData, UiCard, UiText } from '../../shared/ui';
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

/** A try that may fail, with pity: after `pity - 1` failures in a row on the same target the next one is sure. */
export interface Chance {
	/** What the failures are counted on, namespaced by the caller ("<pluginId>:<what>"), per player. */
	target: string;
	/** 0-1 before pity. */
	chance: number;
	/** The try that is sure (counting the failures before it); 0 = the expected number of tries, ceil(1 / chance). */
	pity: number;
	/** Failures are forgotten this many days after the last one. */
	forgetDays: number;
}

/** The odds of a try now: the chance after pity (1 when sure), the failures so far, and the pity count. */
export interface Odds {
	chance: number;
	fails: number;
	pity: number;
}

export interface ItemsService {
	define<P>(def: ItemDef<P>): void;
	list(): readonly ItemDef[];
	/** Where players can get an item, for "you have none" hints, e.g. "shop", "realms". */
	addSource(item: string, source: string): void;
	/**
	 * More of the player's things shown on the Items page as a group of their own (e.g. puzzles, merged a card each):
	 * `data` for the acting player (data only, e.g. their puzzles' progress), null when they have none; the client
	 * assembles the group and its cards from it with the builder registered for `source` (`defineItemCards`,
	 * src/shared/items.ts). Changes only with the player's commits (the view's stamp).
	 */
	addCards(source: string, data: (api: ReadApi) => Promise<unknown>): void;
	count(api: ReadApi, playerId: string, item: string): Promise<number>;
	grant(api: EngineApi, playerId: string, item: string, n: number): Promise<void>;
	/** Remove `n`, or throw `GameError` if the player has fewer. */
	consume(api: EngineApi, playerId: string, item: string, n: number): Promise<void>;
	/** The acting player's odds on a target (see `Chance`). */
	odds(api: ReadApi, c: Chance): Promise<Odds>;
	/** Roll for the acting player: a failure is counted, a success clears the count. */
	attempt(api: EngineApi, c: Chance): Promise<{ ok: boolean } & Odds>;
	/** "pity 1/3" after a target's name; the GM also sees the chance ("50% · pity 1/3"). Players never see odds. */
	describeOdds(api: ReadApi, o: Odds): UiText | null;
	/** What of the odds the viewer may see, as data (the chance only for the GM): for the browser to word (`oddsText`). */
	oddsData(api: ReadApi, o: Odds): OddsData;
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
		const extraCards: { source: string; data: (api: ReadApi) => Promise<unknown> }[] = [];

		/* ----- chances with pity ---------------------------------------------------------- */

		// Every target's failures of the player in one read (an Items page asks for the odds of many targets at once).
		const loadPity = async (api: ReadApi, target: string) => {
			const all = await api.memo(`items:pity:${api.playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT target, fails, expires_at FROM items_pity WHERE player_id = ?')
					.bind(api.playerId)
					.all<{ target: string; fails: number; expires_at: number }>();
				return new Map(results.map((r) => [r.target, { fails: r.expires_at > api.now ? r.fails : 0 }]));
			});
			let state = all.get(target);
			if (!state) all.set(target, (state = { fails: 0 }));
			return state;
		};
		async function odds(api: ReadApi, c: Chance): Promise<Odds> {
			const { fails } = await loadPity(api, c.target);
			const chance = Math.min(1, Math.max(0, c.chance));
			// By default the expected number of tries (1% -> sure by the 100th).
			const pity = c.pity > 0 ? c.pity : chance > 0 ? Math.ceil(1 / chance) : 0;
			const sure = pity > 0 && fails >= pity - 1;
			return { chance: sure ? 1 : chance, fails, pity };
		}
		// Forgotten failures go.
		ctx.tasks.add({
			id: 'items.pity',
			async run({ env, now }) {
				// Hourly is plenty (the cron's first run of each hour; a deployment's runs are 10 minutes apart).
				if (now % 3_600_000 >= 600_000) return;
				await env.DB.prepare('DELETE FROM items_pity WHERE expires_at < ?').bind(now).run();
			},
		});

		const inventory = (api: ReadApi, playerId: string) =>
			api.memo(
				`items:inventory:${playerId}`,
				async () => {
					const { results } = await api.db
						.prepare('SELECT item, count FROM items_inventory WHERE player_id = ?')
						.bind(playerId)
						.all<{ item: string; count: number }>();
					return new Map(results.map((r) => [r.item, r.count]));
				},
				{ current: true },
			);
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
						pending: text('Using {0}…', { 0: keyText(def.name) }),
						...form,
						placement,
						async prepare(api, params) {
							const have = await service.count(api, api.playerId, def.id);
							if (have < 1) return false;
							const raw = prepare ? await prepare(api, params) : {};
							if (raw === false) return false;
							// "<its description> (you have 3)", worded by the browser after the item's own part (web/plugins/items/forms.ts).
							const data: ItemUseFormData = have;
							return { ...raw, data: { ...raw.data, 'items.use': data } };
						},
					},
				});
			},
			list: () => [...defs.values()],
			addCards: (source, data) => void extraCards.push({ source, data }),
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
			odds,
			async attempt(api, c) {
				const o = await odds(api, c);
				const ok = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 < o.chance;
				const state = await loadPity(api, c.target);
				state.fails = ok ? 0 : state.fails + 1;
				api.write(
					ok
						? api.db.prepare('DELETE FROM items_pity WHERE player_id = ? AND target = ?').bind(api.playerId, c.target)
						: api.db
								.prepare(
									`INSERT INTO items_pity (player_id, target, fails, expires_at) VALUES (?, ?, ?, ?)
									 ON CONFLICT (player_id, target) DO UPDATE SET fails = excluded.fails, expires_at = excluded.expires_at`,
								)
								.bind(api.playerId, c.target, state.fails, api.now + c.forgetDays * 86_400_000),
				);
				return { ok, ...o, fails: state.fails };
			},
			oddsData: (api, o) => (api.gmViewer ? { fails: o.fails, pity: o.pity, chance: o.chance } : { fails: o.fails, pity: o.pity }),
			describeOdds: (api, o) => oddsText(service.oddsData(api, o)),
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

		/**
		 * The inventory changes only with the player's commits (using, buying, granting; an adventure's find is committed by
		 * the next command or the minute's sweep): the views of it are sent again only then, or when the rules change.
		 */
		const inventoryStamp = playerStamp;

		/*
		 * The Items page as data (AGENTS.md: the server sends data, the browser assembles the display): what the items
		 * are — names, descriptions, categories, whether they are used — is the static view `items.catalog`; the player's
		 * views carry how many of each they have (`items.owned`) and other plugins' data for their groups (`items.extra`).
		 * The cards (`items.cards`) are worked out from them in the browser (web/plugins/items).
		 */
		ctx.statics.add({
			id: 'items.catalog',
			compute(): ItemCatalog {
				return {
					items: service.list().map((d) => ({
						id: d.id,
						name: d.name,
						...(d.icon ? { icon: d.icon } : {}),
						...(d.description ? { description: d.description } : {}),
						category: d.category ?? 'misc',
						...(d.rarity ? { rarity: d.rarity } : {}),
						usable: !!d.use,
					})),
					categories: Object.fromEntries(categoryLabels),
				};
			},
		});
		ctx.views.add({
			id: 'items.owned',
			quiet: true,
			stamp: inventoryStamp,
			async compute(api): Promise<Record<string, number>> {
				return Object.fromEntries([...(await inventory(api, api.playerId))].filter(([, n]) => n > 0));
			},
		});
		ctx.views.add({
			id: 'items.extra',
			quiet: true,
			stamp: inventoryStamp,
			async compute(api): Promise<ItemsExtra> {
				const got = await Promise.all(extraCards.map(async (x) => ({ source: x.source, data: await x.data(api) })));
				return got.filter((x) => x.data !== null && x.data !== undefined);
			},
		});

		// Items that asked for a button elsewhere (their `shortcuts`), for the compact cards widget: owned, its use form
		// opens in place; not owned, where to get it. All of it is content (`items.shortcut-cards`, static); the player's
		// view only says how many of each they have.
		ctx.statics.add({
			id: 'items.shortcut-cards',
			compute(): CardsData {
				return {
					cards: service.list().flatMap((d) =>
						d.use
							? (d.shortcuts ?? []).map((where): UiCard => {
									const from = sources.get(d.id) ?? [];
									return {
										id: `${d.id}@${where}`,
										where,
										...(d.icon ? { icon: d.icon } : {}),
										title: keyText(d.name),
										...(d.rarity ? { rarity: d.rarity } : {}),
										...(d.description ? { text: keyText(d.description) } : {}),
										detail: { form: { placement: 'items', command: `items.use.${d.id}` } },
										countFrom: `item:${d.id}`,
										ifNone: {
											detail: {
												lines: [text('You have none.'), ...(from.includes('realms') ? [text('It can be found on realm adventures.')] : [])],
											},
											...(from.includes('shop') ? { actions: [{ page: 'shop', label: text('Buy it in the shop') }] } : {}),
										},
									};
								})
							: [],
					),
				};
			},
		});
		// The player's part (how many of each they have) is `items.owned`: the counters are worked out in the browser
		// (`items.shortcuts`, web/plugins/items).

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
					return { options: { item: service.list().map((d) => ({ value: d.id, label: keyText(d.name), count: inv.get(d.id) ?? 0 })) } };
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
