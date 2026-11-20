/**
 * The starter trade routes (docs/design/gameplay.md §17.2): supply trains and field surgeons go along with a team
 * ("开拓队共享的辅助兵种数量不限……其他不能带"), leadership and charm count towards a hero's men. The three routes (the Silk
 * Road, the Tea-Horse Road, the Sea Route) and their stories: 1.7.0 step 6.
 */
import { csvNumber, csvRows, csvRules, definePlugin, PluginError } from '../../kernel';
import type { GoodsDef, TradeLootOccasion } from '../trade-routes';
import goodsCsv from './data/goods.csv?raw';
import buildingsCsv from './data/buildings.csv?raw';
import buildingLevelsCsv from './data/building-levels.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';
import routesCsv from './data/routes.csv?raw';
import nodesCsv from './data/nodes.csv?raw';
import edgesCsv from './data/edges.csv?raw';
import ordersCsv from './data/orders.csv?raw';
import featuresCsv from './data/features.csv?raw';
import dropsCsv from './data/drops.csv?raw';
import storiesCsv from './data/i18n-routes.csv?raw';

const RULES = csvRules(rulesCsv) as { capAttrs: Record<string, number>; aimAttrs: Record<string, number> };

export default definePlugin({
	id: 'starter-trade-routes',
	version: '0.1.0',
	description: 'The starter trade routes: who may go along, how attributes count; the Silk Road, the Tea-Horse Road and the Sea Route',
	dependsOn: [
		'trade-routes',
		'starter-auxiliary',
		'buildings',
		'settlements',
		'player-settlements',
		'items',
		'starter-items',
		'starter-equipment',
		'rebirth',
		'loot',
		'ui',
		'i18n',
	],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		ctx.services.get('i18n').addCsv(storiesCsv, ctx.pluginId);
		const tradeRoutes = ctx.services.get('tradeRoutes');
		tradeRoutes.allowAuxiliary('supply-train');
		tradeRoutes.allowAuxiliary('field-surgeon');
		tradeRoutes.weighAttributes(RULES.capAttrs);
		tradeRoutes.weighAim(RULES.aimAttrs);

		// The trade post: in the outer cities of every kind that has them, one a settlement; each level a point of the stat
		// trade-routes.postLevel (buildings.csv), the trade routes' trade post level (their trade speed).
		const settlements = ctx.services.get('settlements');
		const buildings = ctx.services.get('buildings');
		buildings.defineFromCsv(buildingsCsv, buildingLevelsCsv);
		// Its entry: the trade orders opened, and the deal under way (the trade-routes client widget).
		ctx.services.get('ui').entry({
			kind: 'building',
			types: ['trade-post'],
			widget: 'trade-routes.post',
			// The team is sent from here (its heroes and the garrison).
			props: { view: 'trade-routes.state', views: ['heroes.roster', 'troops.state'] },
		});
		for (const kind of settlements.kinds()) if (kind.outer) settlements.allowCategory(kind.id, kind.outer.type, 'trade');

		// Things new to the routes first turn up at one place each (nodes.csv `prize`; user 2026-11-20: "商路特有的道具+转生
		// 丹，要设计一个首次出现节点"): won the first time it gives one; before, no fight drops it and no merchant has it
		// ("没有经过首次出现的节点的时候，相应的商店节点也永不刷新相关道具").
		const items = ctx.services.get('items');
		const prizeAt = new Map<string, string>(); // item -> "<route>/<node>"
		const prizeOf = new Map<string, string>(); // "<route>/<node>" -> item
		for (const n of csvRows(nodesCsv))
			if (n.prize) {
				if (!items.list().some((i) => i.id === n.prize))
					throw new PluginError(`starter-trade-routes: nodes.csv: unknown prize "${n.prize}"`);
				prizeAt.set(n.prize, `${n.route}/${n.id}`);
				prizeOf.set(`${n.route}/${n.id}`, n.prize);
			}
		tradeRoutes.onFirstWin(async (api, won) => {
			const item = prizeOf.get(`${won.route}/${won.node}`);
			if (!item) return [];
			const def = items.list().find((i) => i.id === item)!;
			await items.grant(api, won.playerId, item, 1);
			return [{ kind: 'item', name: def.name, ...(def.icon ? { icon: def.icon } : {}), count: 1 }];
		});

		// The merchants' goods (goods.csv): the fourth chapter's merchant has the others' too.
		const equipment = ctx.services.get('starterEquipment');
		const rows = csvRows(goodsCsv);
		const goodsOf = (r: Record<string, string>): GoodsDef => {
			const price = csvNumber(r, 'price');
			const weight = csvNumber(r, 'weight', 0);
			const limit = csvNumber(r, 'limit', 1);
			if (r.kind === 'item') {
				const def = items.list().find((i) => i.id === r.item);
				if (!def) throw new PluginError(`starter-trade-routes: goods.csv: unknown item "${r.item}"`);
				const count = csvNumber(r, 'count', 1);
				const line = { kind: 'item', name: def.name, ...(def.icon ? { icon: def.icon } : {}), count };
				return {
					id: r.id,
					price,
					weight,
					limit,
					...(prizeAt.has(def.id) ? { after: prizeAt.get(def.id) } : {}),
					preview: async () => line,
					async give(api, c) {
						await items.grant(api, c.playerId, def.id, count);
						return [line];
					},
				};
			}
			if (r.kind === 'equipment') {
				const spec = { set: r.set, rarity: r.rarity };
				return {
					id: r.id,
					price,
					weight,
					limit,
					async preview(api, random) {
						const { line, stats, base } = equipment.roll(api, spec, random);
						return { ...line, stats, base };
					},
					give: (api, c) => equipment.make(api, c.playerId, c.settlement, spec, c.random, { refuse: true }),
				};
			}
			throw new PluginError(`starter-trade-routes: goods.csv: no kind "${r.kind}"`);
		};
		for (const r of rows) {
			tradeRoutes.addGoods(r.list, goodsOf(r));
			if (r.list === 'merchant') tradeRoutes.addGoods('merchant-rebirth', goodsOf(r));
		}

		// The routes (routes.csv, nodes.csv, edges.csv: written from their stories, each chapter a net closing on its
		// boss), and what their victories drop (drops.csv, by the chapter's stage).
		tradeRoutes.defineFromCsv(routesCsv, nodesCsv, edgesCsv, featuresCsv);
		// Trade orders a fight may open for good (orders.csv), each for the chapters of its stages.
		const orders = csvRows(ordersCsv).map((r) => ({
			id: r.id,
			from: r.from,
			to: r.to,
			amount: csvNumber(r, 'amount'),
			stageFrom: csvNumber(r, 'stageFrom', 1),
			stageTo: csvNumber(r, 'stageTo', 99),
		}));
		tradeRoutes.addOrders(orders.map(({ id, from, to, amount }) => ({ id, from, to, amount })));
		const loot = ctx.services.get('loot');
		const stages = new Map(csvRows(routesCsv).map((r) => [r.id, csvNumber(r, 'stage', 1)]));
		const drops = csvRows(dropsCsv);
		for (const r of drops)
			if (r.kind === 'item' && !items.list().some((i) => i.id === r.item))
				throw new PluginError(`starter-trade-routes: drops.csv: unknown item "${r.item}"`);
		for (const route of csvRows(routesCsv)) {
			const chapters = csvRows(nodesCsv).filter((n) => n.route === route.id && n.pool && n.pool.startsWith(`${ctx.pluginId}.`));
			for (const pool of new Set(chapters.map((n) => n.pool))) {
				const chapter = csvNumber(
					chapters.find((n) => n.pool === pool)!,
					'chapter',
					1,
				);
				const stage = stages.get(route.id)! + chapter - 1;
				for (const r of drops) {
					if (stage < csvNumber(r, 'from', 1) || stage > csvNumber(r, 'to', 99)) continue;
					const weight = csvNumber(r, 'weight', 1);
					const count = csvNumber(r, 'count', 1);
					if (r.kind === 'item') {
						const def = items.list().find((i) => i.id === r.item)!;
						const line = { kind: 'item', name: def.name, ...(def.icon ? { icon: def.icon } : {}), count };
						items.addSource(def.id, 'trade-routes');
						const first = prizeAt.get(def.id);
						loot.addDrop<TradeLootOccasion>(pool, {
							id: r.id,
							weight: first ? (c) => (c.cleared.has(first) ? weight : 0) : weight,
							preview: { kind: 'item', name: def.name, ...(def.icon ? { icon: def.icon } : {}) },
							async give(api, c) {
								await items.grant(api, c.playerId, def.id, count);
								return [line];
							},
						});
					} else if (r.kind === 'equipment') {
						const spec = { set: r.set, rarity: r.rarity };
						loot.addDrop<TradeLootOccasion>(pool, {
							id: r.id,
							weight,
							give: (api, c) => equipment.make(api, c.playerId, c.settlement, spec, c.random),
						});
					} else if (r.kind === 'order') {
						const ids = orders.filter((o) => o.stageFrom <= stage && stage <= o.stageTo).map((o) => o.id);
						if (!ids.length) continue;
						loot.addDrop<TradeLootOccasion>(pool, {
							id: r.id,
							weight,
							give: (api, c) => tradeRoutes.unlockOrder(api, c.playerId, ids, c.random),
						});
					} else throw new PluginError(`starter-trade-routes: drops.csv: no kind "${r.kind}"`);
				}
			}
		}
	},
});
