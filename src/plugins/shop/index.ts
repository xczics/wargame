/**
 * The coupon shop (docs/design/gameplay.md §11): players spend coupons ("yuanbao", owned by the
 * player, never looted, never negative) on offers — an item, how many, the price, an optional
 * daily limit. Offers are registered by content plugins (`defineOffer`); the GM can change price,
 * limit and availability (`shop.offers`) and grants coupons (payment is not built yet).
 */
import { definePlugin, type EngineApi, fields, gameErrors, numberInRange, PluginError, type ReadApi, shape } from '../../kernel';
import type { ShopOffer, ShopStore } from '../../shared/api';
import type { CardsData, UiCard } from '../../shared/ui';
import i18nCsv from './data/i18n.csv?raw';
import { whole } from '../../shared/format';
import { keyText, uiTexts } from '../../shared/i18n';

const fail = gameErrors('shop');
const text = uiTexts('shop');

const DAY = 86_400_000;

export interface OfferDef {
	id: string;
	item: string;
	count: number;
	price: number;
	category: string;
	/** Purchases per day (UTC), 0 = no limit. */
	dailyLimit: number;
}

export interface ShopService {
	defineOffer(def: OfferDef): void;
	offers(): readonly OfferDef[];
	balance(api: ReadApi, playerId: string): Promise<number>;
	/** Add coupons (negative to take; never below zero). */
	grant(api: EngineApi, playerId: string, amount: number): Promise<void>;
}

declare module '../../kernel' {
	interface ServiceMap {
		shop: ShopService;
	}
}

type OfferPatch = Partial<Pick<OfferDef, 'price' | 'dailyLimit'>> & { enabled?: boolean };

export default definePlugin({
	id: 'shop',
	version: '0.1.0',
	description: 'Coupon shop: wallets, offers of items, daily limits, GM grants',
	dependsOn: ['items', 'ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const items = ctx.services.get('items');
		const defs = new Map<string, OfferDef>();

		const overrides = ctx.config.define<Record<string, OfferPatch>>('offers', {
			description: 'Change offers by id: { "<offer>": { "price"?: n, "dailyLimit"?: n, "enabled"?: false } } (partial).',
			default: () => ({}),
			parse(raw) {
				if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
					throw fail('bad_config', 'Expected { offer: { price, dailyLimit, enabled } }');
				const out: Record<string, OfferPatch> = {};
				for (const [id, v] of Object.entries(raw)) {
					if (!defs.has(id)) throw fail('bad_config', text('Unknown offer "{0}"', { 0: id }));
					const p = (v ?? {}) as Record<string, unknown>;
					out[id] = {
						...(p.price !== undefined ? { price: Math.floor(numberInRange(0, 1e9)(p.price)) } : {}),
						...(p.dailyLimit !== undefined ? { dailyLimit: Math.floor(numberInRange(0, 1e6)(p.dailyLimit)) } : {}),
						...(p.enabled !== undefined ? { enabled: p.enabled === true } : {}),
					};
				}
				return out;
			},
		});
		/** Offers as the GM has them now (disabled ones left out). */
		const current = (api: ReadApi) =>
			[...defs.values()].flatMap((d) => {
				const o = overrides.get(api)[d.id] ?? {};
				return o.enabled === false
					? []
					: [
							{
								...d,
								...(o.price !== undefined ? { price: o.price } : {}),
								...(o.dailyLimit !== undefined ? { dailyLimit: o.dailyLimit } : {}),
							},
						];
			});

		const loadWallet = (api: ReadApi, playerId: string) =>
			api.memo(`shop:wallet:${playerId}`, async () => ({
				balance:
					(await api.db.prepare('SELECT balance FROM shop_wallets WHERE player_id = ?').bind(playerId).first<{ balance: number }>())
						?.balance ?? 0,
			}));
		/** Quantity bought today, by offer. */
		const loadToday = (api: ReadApi, playerId: string) =>
			api.memo(`shop:today:${playerId}`, async () => {
				const { results } = await api.db
					.prepare("SELECT offer, SUM(quantity) AS n FROM shop_purchases WHERE player_id = ? AND at >= ? AND offer != '' GROUP BY offer")
					.bind(playerId, Math.floor(api.now / DAY) * DAY)
					.all<{ offer: string; n: number }>();
				return new Map(results.map((r) => [r.offer, r.n]));
			});
		const setBalance = async (api: EngineApi, playerId: string, balance: number) => {
			(await loadWallet(api, playerId)).balance = balance;
			api.write(
				api.db
					.prepare(
						'INSERT INTO shop_wallets (player_id, balance) VALUES (?, ?) ON CONFLICT (player_id) DO UPDATE SET balance = excluded.balance',
					)
					.bind(playerId, balance),
			);
		};
		const log = (api: EngineApi, playerId: string, offer: string, quantity: number, price: number) =>
			api.write(
				api.db
					.prepare('INSERT INTO shop_purchases (id, player_id, offer, quantity, price, at) VALUES (?, ?, ?, ?, ?, ?)')
					.bind(crypto.randomUUID(), playerId, offer, quantity, price, api.now),
			);

		const categoryLabels = new Map<string, string>();
		const service: ShopService = {
			defineOffer(def) {
				if (defs.has(def.id)) throw new PluginError(`Shop offer "${def.id}" defined twice`);
				// Coupons are whole numbers, never fractions.
				if (!Number.isInteger(def.price) || def.price < 0) throw new PluginError(`Shop offer "${def.id}": price must be a whole number`);
				if (!items.list().some((i) => i.id === def.item)) throw new PluginError(`Shop offer "${def.id}": unknown item "${def.item}"`);
				defs.set(def.id, def);
				items.addSource(def.item, 'shop');
				// A category's label: ours if we have one, else that of the first plugin using it.
				const i18n = ctx.services.get('i18n');
				if (!categoryLabels.has(def.category))
					categoryLabels.set(
						def.category,
						i18n.isKey(`shop.shop:${def.category}`) ? `shop.shop:${def.category}` : i18n.own(`shop:${def.category}`),
					);
			},
			offers: () => [...defs.values()],
			balance: async (api, playerId) => (await loadWallet(api, playerId)).balance,
			async grant(api, playerId, amount) {
				const have = await service.balance(api, playerId);
				await setBalance(api, playerId, Math.max(0, have + Math.trunc(amount)));
				log(api, playerId, '', 0, -Math.trunc(amount));
			},
		};
		ctx.services.provide('shop', service);

		ctx.commands.add<{ offer: string; quantity: number }>({
			type: 'shop.buy',
			description: 'Buy an offer with coupons. Payload: { "offer", "quantity"?: 1 }',
			parse: shape({ offer: fields.id(), quantity: fields.orElse(fields.int(1, 100), 1) }),
			async execute(api, { offer: id, quantity }) {
				const offer = current(api).find((o) => o.id === id);
				if (!offer) throw fail('not_found', 'No such offer', 404);
				const today = await loadToday(api, api.playerId);
				const bought = today.get(id) ?? 0;
				if (offer.dailyLimit && bought + quantity > offer.dailyLimit)
					throw fail('blocked', text('Daily limit reached ({0} / {1})', { 0: bought, 1: offer.dailyLimit }));
				const total = offer.price * quantity;
				const have = await service.balance(api, api.playerId);
				if (have < total) throw fail('insufficient_coupons', text('Not enough coupons ({0} / {1})', { 0: have, 1: total }));
				await setBalance(api, api.playerId, have - total);
				await items.grant(api, api.playerId, offer.item, offer.count * quantity);
				today.set(id, bought + quantity);
				log(api, api.playerId, id, quantity, total);
			},
		});

		ctx.commands.add<{ amount: number }>({
			type: 'shop.grant',
			privileged: true,
			description: 'Give the player coupons (negative to take, never below zero). Payload: { "amount": 100 }',
			form: {
				title: text('Give coupons'),
				placement: 'gm',
				fields: [{ name: 'amount', label: text('Coupons (negative to take)'), type: 'number', required: true, default: 100 }],
				submitLabel: text('Give'),
				async prepare(api) {
					return { description: text('Balance: {0}', { 0: await service.balance(api, api.playerId) }) };
				},
			},
			// Coupons are whole: a fraction the GM types is dropped (gameplay.md 11.1).
			parse: shape({ amount: fields.number(-1e9, 1e9) }, (p) => ({ amount: Math.trunc(p.amount) })),
			async execute(api, { amount }) {
				await service.grant(api, api.playerId, amount);
			},
		});

		async function storeOf(api: ReadApi): Promise<ShopStore> {
			const today = await loadToday(api, api.playerId);
			const info = new Map(items.list().map((i) => [i.id, i]));
			const offers: ShopOffer[] = current(api).map((o) => {
				const i = info.get(o.item);
				return {
					id: o.id,
					item: o.item,
					name: i?.name ?? o.item,
					...(i?.icon ? { icon: i.icon } : {}),
					...(i?.rarity ? { rarity: i.rarity } : {}),
					...(i?.description ? { description: i.description } : {}),
					count: o.count,
					price: o.price,
					category: o.category,
					dailyLimit: o.dailyLimit,
					boughtToday: today.get(o.id) ?? 0,
				};
			});
			return { balance: await service.balance(api, api.playerId), offers };
		}
		ctx.views.add({ id: 'shop.store', compute: (api) => storeOf(api) });

		// The same for the generic widgets: categories on the left (ui.filters), offer cards on the right (ui.cards).
		ctx.views.add({
			id: 'shop.cards',
			async compute(api): Promise<CardsData> {
				const { balance, offers } = await storeOf(api);
				return {
					title: text('Shop'),
					summary: [text('💰 {n} yuanbao', { n: whole(balance) })],
					note: text('Bought items go to your inventory; use them on the Items page.'),
					groups: [...new Set(offers.map((o) => o.category))].map((c) => ({ id: c, label: keyText(categoryLabels.get(c)!) })),
					cards: offers.map((o): UiCard => {
						const limited = !!o.dailyLimit && o.boughtToday >= o.dailyLimit;
						const short = balance < o.price;
						return {
							id: o.id,
							group: o.category,
							...(o.icon ? { icon: o.icon } : {}),
							title: keyText(o.name),
							...(o.rarity ? { rarity: o.rarity } : {}),
							count: o.count,
							...(o.description ? { text: keyText(o.description) } : {}),
							lines: [
								{ text: text('💰 {n}', { n: whole(o.price) }), ...(short ? { tone: 'warn' as const } : {}) },
								...(o.dailyLimit
									? [{ text: text('today {n} / {limit}', { n: o.boughtToday, limit: o.dailyLimit }), tone: 'muted' as const }]
									: []),
							],
							actions: [
								{
									command: 'shop.buy',
									payload: { offer: o.id },
									label: text('Buy'),
									notice: text('Bought {0} × {1}: it is in your inventory.', { 0: keyText(o.name), 1: o.count }),
									// The limit first: nothing can be bought today anyway.
									...(limited ? { blocked: text('Daily limit reached') } : short ? { blocked: text('Not enough coupons') } : {}),
								},
							],
						};
					}),
				};
			},
		});

		ctx.reports.add({
			id: 'shop.wallets',
			description: 'Coupon wallets: what each player has, was granted and spent.',
			async run(api) {
				const { results } = await api.db
					.prepare(
						`SELECT w.player_id AS playerId, w.balance,
						   COALESCE((SELECT -SUM(price) FROM shop_purchases p WHERE p.player_id = w.player_id AND p.offer = ''), 0) AS granted,
						   COALESCE((SELECT SUM(price) FROM shop_purchases p WHERE p.player_id = w.player_id AND p.offer != ''), 0) AS spent
						 FROM shop_wallets w ORDER BY w.balance DESC LIMIT 200`,
					)
					.all();
				return results;
			},
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.page({ id: 'shop', label: 'Shop', order: 8.5 });
		ui.block({ page: 'shop', column: 'left', widget: 'ui.filters', props: { view: 'shop.cards', filter: 'shop' } });
		ui.block({ page: 'shop', column: 'right', widget: 'ui.cards', props: { view: 'shop.cards', filter: 'shop' } });
	},
});
