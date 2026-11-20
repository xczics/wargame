/**
 * Trade routes (docs/design/gameplay.md §17.2; user 2026-11-16): routes of linked nodes a player opens up with a team of
 * up to three heroes, each leading a column of one family; the budget (hours) is paid up front as the columns' upkeep and
 * gives the stamina every step and fight takes. What a player cleared stays cleared; one team on the road at a time; when
 * its time is up (or it is called back) what is left of it comes home.
 *
 * The routes come from content plugins (`defineFromCsv`, this plugin's format) and the GM (rule `trade-routes.custom`,
 * the same three tables). Which units may go along besides the columns, and how attributes count towards a hero's men,
 * the content says too (`allowAuxiliary`, `weighAttributes`). A node with enemies is fought for: columns trading blows
 * (src/shared/trade-battle.ts), worked out once here with a random seed, every strike kept for the browser to play.
 */
import {
	csvMap,
	csvNumber,
	csvRows,
	csvRules,
	definePlugin,
	type EngineApi,
	fields,
	gameErrors,
	numberFields,
	numberRecord,
	playerStamp,
	PluginError,
	type ReadApi,
	type RuleView,
	shape,
} from '../../kernel';
import { keyText, uiTexts } from '../../shared/i18n';
import { seededRandom } from '../../shared/random';
import { parseNpcHeroSpec } from '../../shared/npc-heroes';
import { fightColumns, type TradeBattleLog, type TradeBattleRules } from '../../shared/trade-battle';
import {
	guarded,
	type NodeKind,
	neighbours,
	pathCost,
	type RouteDef,
	type RouteNode,
	type GoodsPreview,
	type TradeMerchant,
	type TradeBattleReport,
	type TradeDealRules,
	type TradeOrderDef,
	tradeLoss,
	tradePrice,
	tradeSeconds,
	type TradeColumn,
	type TradeRoutesState,
	type TradeRoutesStatic,
	type TradeRules,
	troopCap,
	aimOf,
} from '../../shared/trade-routes';
import type { RewardLine } from '../../shared/api';
import type { BattleSide, Modifier } from '../battle';
import type { Settlement } from '../settlements';
import type { Cost } from '../resources';
import rulesCsv from './data/rules.csv?raw';
import i18nCsv from './data/i18n.csv?raw';

const fail = gameErrors('trade-routes');
const text = uiTexts('trade-routes');

const RULES = csvRules(rulesCsv);
const BUDGETS = Object.values(RULES.budgets as Record<string, number>);
const RETURN = 'trade-routes.return';
const DEAL = 'trade-routes.deal';
/** The level of a settlement's trade post (the content says which building that is). */
export const POST_LEVEL = 'trade-routes.postLevel';
const DUTY = 'trade-routes.expedition';
const KINDS: readonly NodeKind[] = ['start', 'enemy', 'boss', 'supply', 'merchant', 'key', 'story'];

export interface TradeRoutesService {
	/**
	 * Routes from three tables. `routes`: id, name (a text key), order, chapters (their titles' text keys, "; " between). `nodes`: route, id, chapter, kind (start | enemy |
	 * boss | supply | merchant | key | story; one start a route), x, y (0-1000), width (1-3), enemies (columns front first,
	 * "|" between them, each "unit:n; unit:n"), pool and loot (its reward pool, what a victory draws at least), exp (each
	 * hero's with a victory), name and text (text keys: its name on the map, its story), portrait (who the story shows: an id the browser's art knows), unlock (what clearing it opens for trade: "order:stone>wood:10000;
	 * loss:50"), generals (each enemy column's general by the columns' order, "|" between them, each an NPC hero
	 * "<venue>/<venue level>/<level>", e.g. "tavern/3/45", or empty for none). `edges`: route, a, b.
	 */
	defineFromCsv(routes: string, nodes: string, edges: string): void;
	/** A unit that may go along besides the heroes' columns (e.g. supply trains, field surgeons), shared by the team. */
	allowAuxiliary(unit: string): void;
	/** How an attribute counts towards a hero's men (others: rule `capOther`), e.g. { leadership: 10 }. */
	weighAttributes(weights: Record<string, number>): void;
	/** Which attributes make a hero pick the enemy it counters (rule `aimAttrs`), e.g. { strategy: 1 }. */
	weighAim(weights: Record<string, number>): void;
	/** Trade orders a fight may open for good (each "<id>": unique), for the content's drops (`unlockOrder`). */
	addOrders(orders: TradeOrderDef[]): void;
	/**
	 * Open one of `ids` the player does not have yet, for good (a drop in a fight; user 2026-11-20: "商单……战斗时也要随机
	 * 掉落"), drawn with `random`; what it shows in the fight's rewards, or nothing when the player has them all.
	 */
	unlockOrder(api: EngineApi, playerId: string, ids: readonly string[], random: () => number): Promise<RewardLine[]>;
	/** Every route: the content's and the GM's. */
	routes(api: RuleView): readonly RouteDef[];
	/** Stamina the player's team gains on the road (a story, a supply point): its time out grows to match. */
	gainStamina(api: EngineApi, playerId: string, amount: number): Promise<void>;
	/** Goods for merchants whose node names `list` (its `pool` column): coupons (元宝) for something the shop does not sell. */
	addGoods(list: string, goods: GoodsDef): void;
}

/** What a merchant sells (user 2026-11-16: "商人（可以用元宝购买聚宝阁买不到的限定道具，随机刷新）"). */
/** What a node's pool hears of a victory (`loot.addDrop` on the nodes' pools): where, and the team's home settlement. */
export interface TradeLootOccasion {
	route: string;
	node: string;
	chapter: number;
	settlement: string;
}

export interface GoodsDef {
	id: string;
	/** In coupons (元宝). */
	price: number;
	/** How likely it is among the day's goods; 0: there every day. */
	weight: number;
	/** How many a day (default 1). */
	limit?: number;
	/** What the player sees, `random` the day's (the same as `give` gets: a piece shown is the piece bought). */
	preview(api: ReadApi, random: () => number): Promise<GoodsPreview>;
	/** Hand it over into `settlement` (the team's home); the lines go into the reply. */
	give(api: EngineApi, c: { playerId: string; settlement: string; random: () => number }): Promise<RewardLine[]>;
}

declare module '../../kernel' {
	interface ServiceMap {
		tradeRoutes: TradeRoutesService;
	}
}

/** Routes from the three tables; anything wrong is `bad` (a PluginError for content, bad_config for the GM's). */
export function parseRoutes(routesCsv: string, nodesCsv: string, edgesCsv: string, bad: (msg: string) => Error): RouteDef[] {
	const routes = new Map<string, RouteDef>();
	for (const r of csvRows(routesCsv)) {
		if (!r.id || routes.has(r.id)) throw bad(`routes: "${r.id}" missing or twice`);
		const chapters = (r.chapters ?? '')
			.split(';')
			.map((x) => x.trim())
			.filter(Boolean);
		routes.set(r.id, { id: r.id, name: r.name || r.id, order: csvNumber(r, 'order', 0), chapters, nodes: [], edges: [] });
	}
	for (const n of csvRows(nodesCsv)) {
		const route = routes.get(n.route);
		if (!route) throw bad(`nodes: unknown route "${n.route}"`);
		if (!n.id || route.nodes.some((x) => x.id === n.id)) throw bad(`nodes: "${n.route}/${n.id}" missing or twice`);
		const kind = n.kind as NodeKind;
		if (!KINDS.includes(kind)) throw bad(`nodes: "${n.route}/${n.id}" has no kind "${n.kind}"`);
		const width = csvNumber(n, 'width', kind === 'boss' ? 3 : 1);
		if (![1, 2, 3].includes(width)) throw bad(`nodes: "${n.route}/${n.id}" width is 1-3`);
		const enemies = (n.enemies ?? '')
			.split('|')
			.map((c) => c.trim())
			.filter(Boolean)
			.map((c) => csvMap(c));
		const generals = (n.generals ?? '').split('|').map((c) => parseNpcHeroSpec(c, (m) => bad(`nodes: "${n.route}/${n.id}" ${m}`)));
		if (generals.length > enemies.length && generals.slice(enemies.length).some(Boolean))
			throw bad(`nodes: "${n.route}/${n.id}" has more generals than enemy columns`);
		route.nodes.push({
			id: n.id,
			chapter: csvNumber(n, 'chapter', 1),
			kind,
			x: csvNumber(n, 'x', 0),
			y: csvNumber(n, 'y', 0),
			width,
			enemies,
			...(generals.some(Boolean) ? { generals: generals.slice(0, enemies.length) } : {}),
			...(n.pool ? { pool: n.pool, loot: csvNumber(n, 'loot', 1) } : {}),
			...(n.goods ? { goods: n.goods } : {}),
			...(n.exp ? { exp: csvNumber(n, 'exp', 0) } : {}),
			...(n.name ? { name: n.name } : {}),
			...(n.text ? { text: n.text } : {}),
			...(n.portrait ? { portrait: n.portrait } : {}),
			...(n.first ? { first: n.first } : {}),
			...(n.pass ? { pass: n.pass } : {}),
			...(n.unlock ? { unlock: parseUnlock(n.unlock, `${n.route}/${n.id}`, bad) } : {}),
		});
	}
	for (const e of csvRows(edgesCsv)) {
		const route = routes.get(e.route);
		if (!route) throw bad(`edges: unknown route "${e.route}"`);
		for (const end of [e.a, e.b]) if (!route.nodes.some((x) => x.id === end)) throw bad(`edges: "${e.route}" has no node "${end}"`);
		route.edges.push([e.a, e.b]);
	}
	for (const route of routes.values())
		if (route.nodes.filter((x) => x.kind === 'start').length !== 1) throw bad(`route "${route.id}" needs one start`);
	return [...routes.values()];
}

/** "order:stone>wood:10000; loss:50": the orders a node opens (ids "<route>/<node>#<n>") and its points off the loss. */
function parseUnlock(raw: string, where: string, bad: (msg: string) => Error) {
	const orders: TradeOrderDef[] = [];
	let loss = 0;
	for (const part of raw
		.split(';')
		.map((x) => x.trim())
		.filter(Boolean)) {
		const [kind, a, b] = part.split(':').map((x) => x.trim());
		if (kind === 'loss' && a && !b) loss += Number(a);
		else if (kind === 'order' && a?.includes('>') && b) {
			const [from, to] = a.split('>').map((x) => x.trim());
			orders.push({ id: `${where}#${orders.length + 1}`, from, to, amount: Number(b) });
		} else throw bad(`nodes: "${where}" unlock "${part}" is not "order:from>to:amount" or "loss:points"`);
	}
	if (!Number.isFinite(loss) || orders.some((o) => !(o.amount > 0) || o.from === o.to)) throw bad(`nodes: "${where}" unlock is wrong`);
	return { orders, loss };
}

interface Expedition {
	route: string;
	settlement: string;
	node: string;
	stamina: number;
	startedAt: number;
	endsAt: number;
	team: TradeColumn[];
	auxiliaries: Record<string, number>;
	supplied: string[];
	lastBattle: TradeBattleReport | null;
	recalled: boolean;
}

export default definePlugin({
	id: 'trade-routes',
	version: '0.1.0',
	description: 'Trade routes: a team of heroes and their columns opens up routes of linked nodes, on a budget of stamina',
	dependsOn: ['settlements', 'heroes', 'troops', 'resources', 'timeline', 'battle', 'npc-heroes', 'loot', 'stats', 'shop', 'i18n', 'ui'],
	tables: [
		'trade_routes_bought',
		'trade_routes_cleared',
		'trade_routes_deals',
		'trade_routes_expeditions',
		'trade_routes_orders',
		'trade_routes_unlocked',
	],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const settlements = ctx.services.get('settlements');
		const heroes = ctx.services.get('heroes');
		const troops = ctx.services.get('troops');
		const resources = ctx.services.get('resources');
		const timeline = ctx.services.get('timeline');
		const battle = ctx.services.get('battle');
		const loot = ctx.services.get('loot');
		const stats = ctx.services.get('stats');
		const npcHeroes = ctx.services.get('npcHeroes');
		/** Who leads an enemy column: the same NPC hero wherever it is made (the static view, the fight). */
		const generalSeed = (route: string, node: string, column: number) => `trade-routes:${route}/${node}#${column}`;
		stats.define({ id: POST_LEVEL, description: 'trade post level', base: () => 0, integer: true, min: 0, hidden: true });

		const content: RouteDef[] = [];
		const goodsLists = new Map<string, GoodsDef[]>();
		const auxiliaries = new Set<string>();
		const weights: Record<string, number> = {};
		const droppable = new Map<string, TradeOrderDef>();
		const aimWeights: Record<string, number> = {};

		type Numbers = Omit<TradeRules, 'capAttrs' | 'aimAttrs'>;
		const NUMBERS = Object.fromEntries(
			Object.entries(RULES).filter(([k]) => !['budgets', 'combat', 'epiphany', 'trade', 'merchant'].includes(k)),
		) as Numbers;
		const rules = ctx.config.define('rules', {
			description:
				"perHour: stamina an hour of budget gives; edge: a path; clearedShare: of it once both ends are cleared; battle: a fight; supplyFirst / supplyPass: a supply point won / passed; maxHeroes: a team; capLevel / capOther: a hero's men (level x capLevel + each attribute x capOther, or its own factor in capAttrs); aimHalf: the aim points (aimAttrs) at which a hero (or an enemy general) strikes the enemy it counters half the time.",
			default: () => ({ ...NUMBERS }),
			parse: numberFields(() => ({ ...NUMBERS }), 0, 1e9),
		});
		const capAttrs = ctx.config.define('capAttrs', {
			description: 'How each attribute counts towards a hero\'s men on a trade route, e.g. {"leadership": 10} (others: capOther).',
			default: () => ({ ...weights }),
			parse: (raw) => ({ ...weights, ...numberRecord(() => heroes.attributes().map((a) => a.id), 0, 1e6)(raw) }),
		});
		const aimAttrs = ctx.config.define('aimAttrs', {
			description: 'Which attributes make a hero strike the enemy it counters on a trade route, e.g. {"strategy": 1} (see aimHalf).',
			default: () => ({ ...aimWeights }),
			parse: (raw) => ({ ...aimWeights, ...numberRecord(() => heroes.attributes().map((a) => a.id), 0, 1e6)(raw) }),
		});
		const budgets = ctx.config.define('budgets', {
			description: 'Hours of budget to choose from, e.g. [1, 8, 24, 72].',
			default: () => [...BUDGETS],
			parse: (raw) => {
				if (!Array.isArray(raw) || !raw.length) throw fail('bad_config', 'Expected a list of hours');
				return raw.map((h) => fields.number(0.1, 24 * 365)(h, 'hours'));
			},
		});
		type Combat = TradeBattleRules & { lossShare: number };
		const combat = ctx.config.define('combat', {
			description:
				"Fights on a trade route: pace (a strike's share of attack² / (attack + defence)), miss (chance), spread (each strike's damage up to this share more or less), maxRounds, lossShare (of the men a column's lost hp stands for).",
			default: () => ({ ...(RULES.combat as Combat) }),
			parse: numberFields(() => ({ ...(RULES.combat as Combat) }), 0, 1e6),
		});
		type Epiphany = { chance: number; min: number; max: number };
		const epiphany = ctx.config.define('epiphany', {
			description: 'Each hero who won a fight: chance of an epiphany, and the free points it gives (min to max).',
			default: () => ({ ...(RULES.epiphany as Epiphany) }),
			parse: numberFields(() => ({ ...(RULES.epiphany as Epiphany) }), 0, 1e6),
		});
		const trade = ctx.config.define('trade', {
			description:
				"Trade at a trade post: a deal takes floor + (minutes - floor) / (1 + speed) minutes, speed perLevel % a level up to upTo, then x beyond a level; loss: a deal's loss before any route's points.",
			default: () => ({ ...(RULES.trade as TradeDealRules) }),
			parse: numberFields(() => ({ ...(RULES.trade as TradeDealRules) }), 0, 1e6),
		});
		const merchant = ctx.config.define('merchant', {
			description: 'Merchants on trade routes: count, the goods drawn a day by weight (those always there besides).',
			default: () => ({ ...(RULES.merchant as { count: number }) }),
			parse: numberFields(() => ({ ...(RULES.merchant as { count: number }) }), 0, 100),
		});
		const custom = ctx.config.define('custom', {
			description:
				'Routes the GM adds: { "routes": "<csv>", "nodes": "<csv>", "edges": "<csv>" } in the format of the content\'s (docs/design/gameplay.md §17.2).',
			default: () => ({ routes: '', nodes: '', edges: '' }),
			parse(raw) {
				const r = shape({ routes: fields.text({ max: 1e6 }), nodes: fields.text({ max: 1e6 }), edges: fields.text({ max: 1e6 }) })(raw);
				const parsed = parseRoutes(r.routes, r.nodes, r.edges, (msg) => fail('bad_config', msg));
				for (const route of parsed) {
					if (content.some((c) => c.id === route.id))
						throw fail('bad_config', text('Route "{0}" is the content\'s already', { 0: route.id }));
					for (const n of route.nodes) {
						for (const col of n.enemies)
							for (const unit of Object.keys(col)) if (!troops.get(unit)) throw fail('bad_config', text('Unknown unit "{0}"', { 0: unit }));
						for (const o of n.unlock?.orders ?? [])
							for (const res of [o.from, o.to])
								if (!resources.list().some((x) => x.id === res)) throw fail('bad_config', text('Unknown resource "{0}"', { 0: res }));
					}
				}
				return { ...r, parsed };
			},
		});
		const allRules = (api: RuleView): TradeRules => ({
			...(rules.get(api) as Numbers),
			capAttrs: capAttrs.get(api),
			aimAttrs: aimAttrs.get(api),
		});
		const routesOf = (api: RuleView): readonly RouteDef[] => {
			const c = custom.get(api) as { parsed?: RouteDef[] };
			return [...content, ...(c.parsed ?? [])].sort((a, b) => a.order - b.order);
		};
		const routeOf = (api: RuleView, id: string) => {
			const route = routesOf(api).find((r) => r.id === id);
			if (!route) throw fail('not_found', 'No such trade route', 404);
			return route;
		};
		const startOf = (route: RouteDef) => route.nodes.find((n) => n.kind === 'start')!;

		heroes.defineDuty({ id: DUTY, name: 'Opening a trade route', inTown: false, manual: false, anywhere: true });

		/* ----- storage --------------------------------------------------------------------- */

		const loadCleared = (api: ReadApi, playerId: string) =>
			api.memo(`trade-routes:cleared:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT route, node FROM trade_routes_cleared WHERE player_id = ?')
					.bind(playerId)
					.all<{ route: string; node: string }>();
				const out = new Map<string, Set<string>>();
				for (const r of results) (out.get(r.route) ?? out.set(r.route, new Set()).get(r.route)!).add(r.node);
				return out;
			});
		const isCleared = (cleared: Map<string, Set<string>>, route: RouteDef, node: string) =>
			node === startOf(route).id || !!cleared.get(route.id)?.has(node);
		const clear = async (api: EngineApi, playerId: string, route: string, node: string) => {
			const cleared = await loadCleared(api, playerId);
			if (cleared.get(route)?.has(node)) return;
			(cleared.get(route) ?? cleared.set(route, new Set()).get(route)!).add(node);
			api.write(
				api.db.prepare('INSERT OR IGNORE INTO trade_routes_cleared (player_id, route, node) VALUES (?, ?, ?)').bind(playerId, route, node),
			);
		};

		// Kept in a box: coming home empties it for whatever this call reads after.
		const expeditionBox = (api: ReadApi, playerId: string) =>
			api.memo(`trade-routes:expedition:${playerId}`, async (): Promise<{ e: Expedition | null }> => {
				const r = await api.db
					.prepare(
						'SELECT settlement_id, route, node, stamina, started_at, ends_at, team, auxiliaries, supplied, last_battle, recalled FROM trade_routes_expeditions WHERE player_id = ?',
					)
					.bind(playerId)
					.first<{
						settlement_id: string;
						route: string;
						node: string;
						stamina: number;
						started_at: number;
						ends_at: number;
						team: string;
						auxiliaries: string;
						supplied: string;
						last_battle: string | null;
						recalled: number;
					}>();
				return {
					e: r
						? {
								route: r.route,
								settlement: r.settlement_id,
								node: r.node,
								stamina: r.stamina,
								startedAt: r.started_at,
								endsAt: r.ends_at,
								team: JSON.parse(r.team) as TradeColumn[],
								auxiliaries: JSON.parse(r.auxiliaries) as Record<string, number>,
								supplied: JSON.parse(r.supplied) as string[],
								lastBattle: r.last_battle ? (JSON.parse(r.last_battle) as TradeBattleReport) : null,
								recalled: !!r.recalled,
							}
						: null,
				};
			});
		const loadExpedition = async (api: ReadApi, playerId: string) => (await expeditionBox(api, playerId)).e;
		const writeExpedition = (api: EngineApi, playerId: string, e: Expedition) =>
			api.write(
				api.db
					.prepare(
						`INSERT INTO trade_routes_expeditions (player_id, settlement_id, route, node, stamina, started_at, ends_at, team, auxiliaries, supplied, last_battle, recalled)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT (player_id) DO UPDATE SET node = excluded.node, stamina = excluded.stamina, ends_at = excluded.ends_at,
						   team = excluded.team, auxiliaries = excluded.auxiliaries, supplied = excluded.supplied, last_battle = excluded.last_battle,
						   recalled = excluded.recalled`,
					)
					.bind(
						playerId,
						e.settlement,
						e.route,
						e.node,
						Math.max(0, e.stamina),
						e.startedAt,
						e.endsAt,
						JSON.stringify(e.team),
						JSON.stringify(e.auxiliaries),
						JSON.stringify(e.supplied),
						e.lastBattle ? JSON.stringify(e.lastBattle) : null,
						e.recalled ? 1 : 0,
					),
			);

		/** The team's way home, at `endsAt` (on its settlement: what is due there runs when it is next looked at). */
		const scheduleReturn = (api: EngineApi, playerId: string, e: Expedition) => {
			const holder = settlements.entity(e.settlement);
			timeline.cancelWhere(api, holder, RETURN, { player: playerId });
			timeline.schedule(api, holder, e.endsAt, RETURN, { player: playerId });
		};
		/** Home: what is left of the columns and the auxiliaries back in the garrison, the heroes off duty. */
		async function comeHome(api: EngineApi, playerId: string, e: Expedition) {
			const home = await settlements.get(api, e.settlement);
			if (home?.ownerId === playerId) {
				const units: Record<string, number> = { ...e.auxiliaries };
				for (const c of e.team) for (const [u, n] of Object.entries(c.units)) units[u] = (units[u] ?? 0) + n;
				for (const [u, n] of Object.entries(units)) if (n > 0) await troops.adjust(api, e.settlement, u, n);
			}
			for (const c of e.team) {
				const hero = await heroes.get(api, c.hero);
				if (hero?.duty === DUTY) await heroes.assign(api, c.hero, 'idle', null);
			}
			api.write(api.db.prepare('DELETE FROM trade_routes_expeditions WHERE player_id = ?').bind(playerId));
			(await expeditionBox(api, playerId)).e = null;
		}
		timeline.on<{ player: string }>(RETURN, async (api, event) => {
			const e = await loadExpedition(api, event.payload.player);
			if (!e || e.endsAt > event.dueAt) return; // called back already, or out for longer now
			await comeHome(api, event.payload.player, e);
		});

		/** The player's team on the road, its time not up and not called home. */
		async function onTheRoad(api: EngineApi) {
			const e = await loadExpedition(api, api.playerId);
			if (!e || e.endsAt <= api.now) throw fail('not_found', 'No team of yours is on a trade route', 404);
			if (e.recalled) throw fail('blocked', 'The team is on its way home');
			return e;
		}
		/** Stamina gained: an hour more out for each `perHour` of it. */
		const gain = (api: RuleView, e: Expedition, amount: number) => {
			e.stamina += amount;
			e.endsAt += (amount / allRules(api).perHour) * 3_600_000;
		};

		const service: TradeRoutesService = {
			defineFromCsv(routesCsv, nodesCsv, edgesCsv) {
				for (const route of parseRoutes(routesCsv, nodesCsv, edgesCsv, (msg) => new PluginError(`trade-routes: ${msg}`))) {
					if (content.some((r) => r.id === route.id)) throw new PluginError(`trade-routes: route "${route.id}" defined twice`);
					content.push(route);
					// Each node's reward pool, for content plugins to fill (`loot.addDrop`).
					for (const n of route.nodes) if (n.pool && guarded(n) && !goodsLists.has(n.pool) && !loot.has(n.pool)) loot.definePool(n.pool);
				}
			},
			allowAuxiliary: (unit) => void auxiliaries.add(unit),
			weighAttributes: (w) => void Object.assign(weights, w),
			weighAim: (w) => void Object.assign(aimWeights, w),
			addOrders(orders) {
				for (const o of orders) {
					if (droppable.has(o.id)) throw new PluginError(`trade-routes: order "${o.id}" added twice`);
					droppable.set(o.id, o);
				}
			},
			async unlockOrder(api, playerId, ids, random) {
				const held = await loadUnlocked(api, playerId);
				const open = ids.filter((id) => droppable.has(id) && !held.has(id));
				if (!open.length) return [];
				const order = droppable.get(open[Math.min(open.length - 1, Math.floor(random() * open.length))])!;
				held.add(order.id);
				api.write(
					api.db.prepare('INSERT OR IGNORE INTO trade_routes_unlocked (player_id, order_id) VALUES (?, ?)').bind(playerId, order.id),
				);
				const name = (id: string) => keyText(resources.list().find((x) => x.id === id)?.name ?? id);
				return [
					{
						kind: 'trade-order',
						name: 'trade-routes.Trade order',
						label: text('Trade order: {0} {1} a day, for {2}', { 0: name(order.to), 1: order.amount, 2: name(order.from) }),
						icon: 'camel',
					},
				];
			},
			routes: routesOf,
			addGoods(list, goods) {
				const all = goodsLists.get(list) ?? [];
				if (all.some((g) => g.id === goods.id)) throw new PluginError(`trade-routes: goods "${goods.id}" in "${list}" twice`);
				all.push(goods);
				goodsLists.set(list, all);
			},
			async gainStamina(api, playerId, amount) {
				const e = await loadExpedition(api, playerId);
				if (!e || amount <= 0) return;
				gain(api, e, amount);
				writeExpedition(api, playerId, e);
				scheduleReturn(api, playerId, e);
			},
		};
		ctx.services.provide('tradeRoutes', service);

		/* ----- setting out, walking, coming home ---------------------------------------------------- */

		const unitsField = fields.record(fields.int(1, 1e9), { max: 50 });
		ctx.commands.add<{ settlement: string; route: string; hours: number; team: TradeColumn[]; auxiliaries: Record<string, number> }>({
			type: 'trade-routes.depart',
			description:
				'Send a team out on a trade route: up to three heroes of the settlement, each with a column of one family, and auxiliaries; the budget (hours) is paid now as their upkeep. Payload: { "settlement", "route", "hours", "team": [{ "hero", "units": { "unit": n } }], "auxiliaries"?: { "unit": n } }',
			parse: shape({
				settlement: fields.id(),
				route: fields.id(),
				hours: fields.number(0.1, 24 * 365),
				team: fields.list(fields.object({ hero: fields.id(), units: unitsField }), { min: 1, max: 10 }),
				auxiliaries: fields.orElse(fields.record(fields.int(1, 1e9), { max: 20 }), {}),
			}),
			async execute(api, { settlement: settlementId, route: routeId, hours, team, auxiliaries: aux }) {
				const r = allRules(api);
				const settlement = await settlements.requireOwned(api, settlementId);
				const route = routeOf(api, routeId);
				if (await loadExpedition(api, api.playerId)) throw fail('busy', 'A team of yours is on a trade route already');
				if (!budgets.get(api).includes(hours)) throw fail('bad_payload', 'Not a budget to choose from');
				if (team.length > r.maxHeroes) throw fail('bad_payload', text('{0} heroes at most', { 0: r.maxHeroes }));
				if (new Set(team.map((c) => c.hero)).size !== team.length) throw fail('bad_payload', 'A hero only once');
				// Each column: a hero of this settlement, free to go, leading one family, no more than it may.
				const all: Record<string, number> = {};
				for (const c of team) {
					const hero = await heroes.requireOwned(api, api.playerId, c.hero);
					heroes.requireFree(hero);
					if (hero.home !== settlement.id) throw fail('bad_payload', 'A hero of this settlement only');
					const families = new Set(Object.keys(c.units).map((u) => troops.get(u)?.family));
					if (families.size !== 1 || families.has(undefined)) throw fail('bad_payload', 'Each hero leads troops of one family');
					const men = Object.values(c.units).reduce((a, b) => a + b, 0);
					const cap = troopCap(r, hero.level, await heroes.attributesOf(api, hero));
					if (men > cap) throw fail('too_many', text('This hero leads {0} men at most', { 0: cap }));
					for (const [u, n] of Object.entries(c.units)) all[u] = (all[u] ?? 0) + n;
				}
				for (const [u, n] of Object.entries(aux)) {
					if (!auxiliaries.has(u)) throw fail('bad_payload', text('{0} may not go along', { 0: u }));
					all[u] = (all[u] ?? 0) + n;
				}
				const garrison = await troops.garrison(api, settlement.id);
				for (const [u, n] of Object.entries(all)) if ((garrison.get(u) ?? 0) < n) throw fail('not_enough', 'Not enough troops');
				// The budget: their upkeep for the hours, as the settlement keeps them (its upkeep modifiers), carried along.
				const factor = (await troops.upkeepFactors(api, settlement.id)).reduce((a, p) => a * p.factor, 1);
				const cost: Cost = {};
				for (const [u, n] of Object.entries(all))
					for (const [res, perSecond] of Object.entries(troops.stats(api, u).upkeep))
						cost[res] = (cost[res] ?? 0) + perSecond * n * 3600 * hours * factor;
				for (const res of Object.keys(cost)) cost[res] = Math.ceil(cost[res]);
				const load = Object.values(cost).reduce((a, b) => a + b, 0);
				const carry = troops.totals(api, all).carry;
				if (carry < load) throw fail('too_heavy', text('They carry {0} at most', { 0: Math.floor(carry) }));
				await resources.spend(api, settlements.entity(settlement.id), cost);
				for (const [u, n] of Object.entries(all)) await troops.adjust(api, settlement.id, u, -n);
				for (const c of team) await heroes.assign(api, c.hero, DUTY, settlement.id);
				const e: Expedition = {
					route: route.id,
					settlement: settlement.id,
					node: startOf(route).id,
					stamina: r.perHour * hours,
					startedAt: api.now,
					endsAt: api.now + hours * 3_600_000,
					team: team.map((c) => ({ hero: c.hero, units: { ...c.units } })),
					auxiliaries: { ...aux },
					supplied: [],
					lastBattle: null,
					recalled: false,
				};
				(await expeditionBox(api, api.playerId)).e = e;
				writeExpedition(api, api.playerId, e);
				scheduleReturn(api, api.playerId, e);
			},
		});

		/** Arrived at a node: nothing to fight there clears it; a cleared supply point gives once each time out. */
		async function arrive(api: EngineApi, e: Expedition, route: RouteDef, to: string) {
			const node = route.nodes.find((n) => n.id === to)!;
			e.node = to;
			if (!guarded(node)) await clear(api, api.playerId, route.id, to);
			if (node.kind === 'supply' && !e.supplied.includes(to)) {
				e.supplied.push(to);
				gain(api, e, allRules(api).supplyPass);
				scheduleReturn(api, api.playerId, e);
			}
		}

		ctx.commands.add<{ node: string }>({
			type: 'trade-routes.move',
			description:
				'Walk the team on to a neighbouring node: a path takes stamina (a third of it once both ends are cleared); a node with enemies not yet beaten has to be fought for. Payload: { "node" }',
			parse: shape({ node: fields.id() }),
			async execute(api, { node: to }) {
				const r = allRules(api);
				const e = await onTheRoad(api);
				const route = routeOf(api, e.route);
				const target = route.nodes.find((n) => n.id === to);
				if (!target || !neighbours(route, e.node).includes(to)) throw fail('bad_payload', 'Not a neighbouring node');
				const cleared = await loadCleared(api, api.playerId);
				if (guarded(target) && !isCleared(cleared, route, to)) throw fail('blocked', 'Enemies stand there: fight your way in');
				const cost = pathCost(r, isCleared(cleared, route, e.node) && isCleared(cleared, route, to));
				if (e.stamina + 1e-9 < cost) throw fail('tired', 'Not enough stamina');
				e.stamina -= cost;
				await arrive(api, e, route, to);
				writeExpedition(api, api.playerId, e);
			},
		});

		ctx.commands.add<null>({
			type: 'trade-routes.recall',
			description:
				'Call the team home (the budget is not given back): it is back when the stamina it spent would have taken (from setting out, at perHour an hour), at once if that is past; on its way it does nothing more.',
			parse: () => null,
			async execute(api) {
				const e = await onTheRoad(api);
				// The time the spent stamina stands for (user 2026-11-20: "已经消耗的体力点应该换算成时间，只有时间结束后，英雄和剩余
				// 部队才可返回"; from setting out): endsAt already counts every gain, so it is endsAt less what is left.
				const back = Math.max(api.now, e.endsAt - (e.stamina / allRules(api).perHour) * 3_600_000);
				if (back <= api.now) {
					timeline.cancelWhere(api, settlements.entity(e.settlement), RETURN, { player: api.playerId });
					await comeHome(api, api.playerId, e);
					return;
				}
				e.endsAt = back;
				e.stamina = 0;
				e.recalled = true;
				writeExpedition(api, api.playerId, e);
				scheduleReturn(api, api.playerId, e);
			},
		});

		/* ----- fights ---------------------------------------------------------------------- */

		/** A column's numbers by the battle's own reckoning (`battle.laneNumbers`, its counter, its casualty factor). */
		const column = (api: ReadApi, id: string, units: Record<string, number>, mods: readonly Modifier[]) => {
			const family =
				Object.keys(units)
					.map((u) => troops.get(u)?.family)
					.find(Boolean) ?? '';
			const n = battle.laneNumbers(api, { family, units }, mods);
			const boost = battle.counterBoost(api, mods, family) - 1;
			return {
				id,
				...(family ? { family } : {}),
				attack: n.attack,
				defense: n.defense,
				hp: n.hp,
				counterAttack: n.attack + n.attackTroops * boost,
				counterDefense: n.defense + n.defenseTroops * boost,
				casualty: battle.casualtyFactor(mods, family),
			};
		};
		/** A hero's column on its side: the player's and the hero's bonuses, as when leading an army. */
		async function ourColumn(api: EngineApi, home: Settlement | null, c: TradeColumn) {
			const side: BattleSide = { role: 'attacker', playerId: api.playerId, settlement: home, heroes: [c.hero] };
			const enemy: BattleSide = { role: 'defender', playerId: null, settlement: null };
			const mods = await battle.modifiers(api, side, { attacker: side, defender: enemy });
			const hero = await heroes.requireOwned(api, api.playerId, c.hero);
			const aim = aimOf(allRules(api), await heroes.attributesOf(api, hero));
			return { ...column(api, c.hero, c.units, mods), aim };
		}

		ctx.commands.add<{ node: string; heroes: string[] }>({
			type: 'trade-routes.fight',
			description:
				'Fight for a neighbouring node with some of the team\'s columns (no more than its width): stamina for the path and the fight; won, the node is cleared and the team moves in, with what it drops, experience, maybe an epiphany. Payload: { "node", "heroes": [hero] }',
			parse: shape({ node: fields.id(), heroes: fields.list(fields.id(), { min: 1, max: 3 }) }),
			async execute(api, { node: to, heroes: sent }) {
				const r = allRules(api);
				const e = await onTheRoad(api);
				const route = routeOf(api, e.route);
				const target = route.nodes.find((n) => n.id === to);
				if (!target || !neighbours(route, e.node).includes(to)) throw fail('bad_payload', 'Not a neighbouring node');
				const cleared = await loadCleared(api, api.playerId);
				if (!guarded(target) || isCleared(cleared, route, to)) throw fail('blocked', 'Nothing to fight there');
				if (new Set(sent).size !== sent.length) throw fail('bad_payload', 'A hero only once');
				if (sent.length > target.width) throw fail('bad_payload', text('{0} columns fight here at most', { 0: target.width }));
				const columns = sent.map((h) => {
					const c = e.team.find((x) => x.hero === h);
					if (!c || !Object.values(c.units).some((n) => n > 0)) throw fail('bad_payload', 'Not a column of the team');
					return c;
				});
				// The node is not cleared: the path at full cost.
				const cost = pathCost(r, false) + r.battle;
				if (e.stamina + 1e-9 < cost) throw fail('tired', 'Not enough stamina');
				e.stamina -= cost;

				const c = combat.get(api) as Combat;
				const home = await settlements.get(api, e.settlement);
				const ours = await Promise.all(columns.map((col) => ourColumn(api, home, col)));
				// Each enemy column under its general, if it has one (as an NPC's, nothing worn); with none, it strikes at random.
				const theirs = await Promise.all(
					target.enemies.map(async (units, i) => {
						const spec = target.generals?.[i];
						if (!spec) return column(api, `enemy-${i}`, units, []);
						const general = npcHeroes.make(api, spec, generalSeed(route.id, target.id, i));
						const side: BattleSide = { role: 'defender', playerId: null, settlement: null, generals: [general] };
						const attacker: BattleSide = { role: 'attacker', playerId: api.playerId, settlement: home };
						const mods = await battle.modifiers(api, side, { attacker, defender: side });
						return { ...column(api, `enemy-${i}`, units, mods), aim: aimOf(r, general.attrs) };
					}),
				);
				const random = seededRandom(`trade-routes:${api.playerId}:${crypto.getRandomValues(new Uint32Array(2)).join('.')}`);
				const log: TradeBattleLog = fightColumns(ours, theirs, target.width, c, random, (a, b) => battle.counters(a, b));

				// Losses: each column's share of hp lost, by its casualty bonuses; then the side's last word (surgeons), spread
				// back over the columns as each lost before it.
				const before: Record<string, Record<string, number>> = {};
				const losses: Record<string, number> = {};
				for (const [i, col] of columns.entries()) {
					const share = 1 - (log.left[col.hero] ?? 0) / (ours[i].hp || 1);
					before[col.hero] = {};
					for (const [u, n] of Object.entries(col.units)) {
						const lost = Math.min(n, Math.round(n * share * c.lossShare * ours[i].casualty));
						if (!lost) continue;
						before[col.hero][u] = lost;
						losses[u] = (losses[u] ?? 0) + lost;
					}
				}
				const everyone: Record<string, number> = { ...e.auxiliaries };
				for (const col of e.team) for (const [u, n] of Object.entries(col.units)) everyone[u] = (everyone[u] ?? 0) + n;
				const side: BattleSide = { role: 'attacker', playerId: api.playerId, settlement: home, heroes: sent };
				const final = await battle.finalLosses(api, side, everyone, losses);
				const lost: Record<string, Record<string, number>> = {};
				for (const col of columns) {
					lost[col.hero] = {};
					for (const [u, n] of Object.entries(before[col.hero])) {
						const down = Math.min(col.units[u], Math.round(n * ((final.losses[u] ?? 0) / losses[u])));
						if (!down) continue;
						lost[col.hero][u] = down;
						col.units[u] -= down;
					}
				}

				const report: TradeBattleReport = { node: to, log, lost, saved: final.adjustments, rewards: [], exp: 0, epiphanies: {} };
				if (log.won) {
					await clear(api, api.playerId, route.id, to);
					await arrive(api, e, route, to);
					if (target.kind === 'supply') gain(api, e, r.supplyFirst);
					// What it drops, the experience of those who fought, maybe an epiphany.
					if (target.pool && loot.has(target.pool) && !loot.empty(target.pool)) {
						const occasion: TradeLootOccasion & { playerId: string; random: () => number } = {
							playerId: api.playerId,
							route: route.id,
							node: to,
							chapter: target.chapter,
							settlement: e.settlement,
							random,
						};
						const ids = await loot.roll(api, target.pool, occasion, target.loot ?? 1, random);
						report.rewards = await loot.give(api, target.pool, ids, occasion);
					}
					const ep = epiphany.get(api) as Epiphany;
					for (const h of sent) {
						if (target.exp) await heroes.grantExp(api, h, target.exp);
						if (random() < ep.chance) {
							const points = ep.min + Math.floor(random() * (Math.max(ep.min, ep.max) - ep.min + 1));
							await heroes.grantFreePoints(api, h, points);
							report.epiphanies[h] = points;
						}
					}
					report.exp = target.exp ?? 0;
					scheduleReturn(api, api.playerId, e);
				}
				e.lastBattle = report;
				writeExpedition(api, api.playerId, e);
			},
		});

		/* ----- trade ---------------------------------------------------------------------- */

		const today = (api: { now: number }) => Math.floor(api.now / 86_400_000);
		/** What the player's cleared nodes open for trade: the orders, the points off the loss. */
		/** Orders a player opened with drops (memoised: the fight that opens one reads them first). */
		const loadUnlocked = (api: ReadApi, playerId: string) =>
			api.memo(`trade-routes:unlocked:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT order_id FROM trade_routes_unlocked WHERE player_id = ?')
					.bind(playerId)
					.all<{ order_id: string }>();
				return new Set(results.map((r) => r.order_id));
			});
		async function opened(api: ReadApi, playerId: string) {
			const cleared = await loadCleared(api, playerId);
			const orders: TradeOrderDef[] = [...(await loadUnlocked(api, playerId))].flatMap((id) => droppable.get(id) ?? []);
			let loss = 0;
			for (const route of routesOf(api))
				for (const n of route.nodes)
					if (n.unlock && isCleared(cleared, route, n.id)) {
						orders.push(...n.unlock.orders);
						loss += n.unlock.loss;
					}
			return { orders, loss };
		}
		const loadUsed = (api: ReadApi, playerId: string) =>
			api.memo(`trade-routes:used:${playerId}:${today(api)}`, async () => {
				const { results } = await api.db
					.prepare('SELECT order_id FROM trade_routes_orders WHERE player_id = ? AND day = ?')
					.bind(playerId, today(api))
					.all<{ order_id: string }>();
				return new Set(results.map((r) => r.order_id));
			});
		type Deal = { settlement: string; order: string; resource: string; amount: number; startedAt: number; finishesAt: number };
		const loadDeals = (api: ReadApi, playerId: string) =>
			api.memo(`trade-routes:deals:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT settlement_id, order_id, resource, amount, started_at, finishes_at FROM trade_routes_deals WHERE player_id = ?')
					.bind(playerId)
					.all<{ settlement_id: string; order_id: string; resource: string; amount: number; started_at: number; finishes_at: number }>();
				return new Map<string, Deal>(
					results.map((r) => [
						r.settlement_id,
						{
							settlement: r.settlement_id,
							order: r.order_id,
							resource: r.resource,
							amount: r.amount,
							startedAt: r.started_at,
							finishesAt: r.finishes_at,
						},
					]),
				);
			});

		ctx.commands.add<{ settlement: string; order: string }>({
			type: 'trade-routes.trade',
			description:
				'Fill a trade order at a settlement\'s trade post (each order once a day): pay its price now (by the resources\' values, plus the loss), have its amount when the deal is done. Payload: { "settlement", "order" }',
			parse: shape({ settlement: fields.id(), order: fields.text({ max: 200 }) }),
			async execute(api, { settlement: settlementId, order: orderId }) {
				const settlement = await settlements.requireOwned(api, settlementId);
				const holder = settlements.entity(settlement.id);
				await timeline.sync(api, holder); // what is due there first (a trade post just built or raised)
				const level = await stats.get(api, POST_LEVEL, holder);
				if (level < 1) throw fail('blocked', 'This settlement has no trade post');
				const { orders, loss } = await opened(api, api.playerId);
				const order = orders.find((o) => o.id === orderId);
				if (!order) throw fail('not_found', 'No such trade order of yours', 404);
				const used = await loadUsed(api, api.playerId);
				if (used.has(order.id)) throw fail('blocked', 'This order was filled today already');
				const deals = await loadDeals(api, api.playerId);
				if (deals.has(settlement.id)) throw fail('busy', 'This trade post is busy with a deal');
				const r = trade.get(api) as TradeDealRules;
				const price = tradePrice(order, resources.value(api, order.from), resources.value(api, order.to), tradeLoss(r, loss));
				await resources.spend(api, holder, { [order.from]: price });
				const deal: Deal = {
					settlement: settlement.id,
					order: order.id,
					resource: order.to,
					amount: order.amount,
					startedAt: api.now,
					finishesAt: api.now + tradeSeconds(r, level) * 1000,
				};
				used.add(order.id);
				deals.set(settlement.id, deal);
				api.write(
					api.db
						.prepare('INSERT INTO trade_routes_orders (player_id, order_id, day) VALUES (?, ?, ?)')
						.bind(api.playerId, order.id, today(api)),
				);
				api.write(
					api.db
						.prepare(
							'INSERT INTO trade_routes_deals (settlement_id, player_id, order_id, resource, amount, started_at, finishes_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
						)
						.bind(settlement.id, api.playerId, order.id, deal.resource, deal.amount, deal.startedAt, deal.finishesAt),
				);
				timeline.schedule(api, holder, deal.finishesAt, DEAL, { settlement: settlement.id, player: api.playerId });
			},
		});
		// A deal done: what was bought comes in.
		timeline.on<{ settlement: string; player: string }>(DEAL, async (api, event) => {
			const deals = await loadDeals(api, event.payload.player);
			const deal = deals.get(event.payload.settlement);
			if (!deal) return;
			await resources.add(api, settlements.entity(deal.settlement), deal.resource, deal.amount);
			deals.delete(deal.settlement);
			api.write(api.db.prepare('DELETE FROM trade_routes_deals WHERE settlement_id = ?').bind(deal.settlement));
		});

		/* ----- merchants ---------------------------------------------------------------------- */

		/** A merchant's goods today for the player: the ones always there and `count` drawn by weight, each with its seed. */
		function stockOf(api: ReadApi, playerId: string, route: string, node: RouteNode) {
			// Its goods list: the `goods` column (a merchant guarded like every place has a loot pool too), else its pool.
			const listId = node.goods ?? node.pool;
			const list = listId ? (goodsLists.get(listId) ?? []) : [];
			const seed = `trade-routes:merchant:${playerId}:${route}/${node.id}:${today(api)}`;
			const random = seededRandom(seed);
			const always = list.filter((g) => g.weight <= 0);
			const pool = list.filter((g) => g.weight > 0);
			const drawn: GoodsDef[] = [];
			for (let i = 0; i < (merchant.get(api) as { count: number }).count && pool.length; i++) {
				const total = pool.reduce((a, g) => a + g.weight, 0);
				let at = random() * total;
				const k = Math.max(
					0,
					pool.findIndex((g) => (at -= g.weight) < 0),
				);
				drawn.push(...pool.splice(k, 1));
			}
			return [...always, ...drawn].map((g) => ({ goods: g, random: () => seededRandom(`${seed}:${g.id}`) }));
		}
		const loadBought = (api: ReadApi, playerId: string) =>
			api.memo(`trade-routes:bought:${playerId}:${today(api)}`, async () => {
				const { results } = await api.db
					.prepare('SELECT merchant, goods, count FROM trade_routes_bought WHERE player_id = ? AND day = ?')
					.bind(playerId, today(api))
					.all<{ merchant: string; goods: string; count: number }>();
				return new Map(results.map((r) => [`${r.merchant}|${r.goods}`, r.count]));
			});
		/** The merchant where the team stands now, if it stands at one. */
		async function merchantHere(api: ReadApi) {
			const e = await loadExpedition(api, api.playerId);
			if (!e || e.endsAt <= api.now || e.recalled) return null;
			const route = routesOf(api).find((r) => r.id === e.route);
			const node = route?.nodes.find((n) => n.id === e.node);
			return route && node?.kind === 'merchant' ? { e, route, node } : null;
		}

		ctx.commands.add<{ goods: string }>({
			type: 'trade-routes.buy',
			description:
				'Buy from the merchant where the team stands, with coupons: what it has today (the same for the whole day), into the team\'s home. Payload: { "goods" }',
			parse: shape({ goods: fields.text({ max: 200 }) }),
			async execute(api, { goods: goodsId }) {
				const here = await merchantHere(api);
				if (!here) throw fail('not_found', 'No merchant where your team stands', 404);
				const item = stockOf(api, api.playerId, here.route.id, here.node).find((x) => x.goods.id === goodsId);
				if (!item) throw fail('not_found', 'The merchant has none of that today', 404);
				const key = `${here.route.id}/${here.node.id}`;
				const bought = await loadBought(api, api.playerId);
				const n = bought.get(`${key}|${goodsId}`) ?? 0;
				if (n >= (item.goods.limit ?? 1)) throw fail('blocked', 'Sold out for today');
				await ctx.services.get('shop').spend(api, api.playerId, item.goods.price);
				await item.goods.give(api, { playerId: api.playerId, settlement: here.e.settlement, random: item.random() });
				bought.set(`${key}|${goodsId}`, n + 1);
				api.write(
					api.db
						.prepare(
							`INSERT INTO trade_routes_bought (player_id, merchant, goods, day, count) VALUES (?, ?, ?, ?, 1)
							 ON CONFLICT (player_id, merchant, goods, day) DO UPDATE SET count = count + 1`,
						)
						.bind(api.playerId, key, goodsId, today(api)),
				);
			},
		});
		// The merchant's goods where the team stands (asked for on its screen).
		ctx.views.add({
			id: 'trade-routes.merchant',
			quiet: true,
			stamp: playerStamp,
			async compute(api): Promise<TradeMerchant | null> {
				const here = await merchantHere(api);
				if (!here) return null;
				const key = `${here.route.id}/${here.node.id}`;
				const bought = await loadBought(api, api.playerId);
				const goods = [];
				for (const { goods: g, random } of stockOf(api, api.playerId, here.route.id, here.node))
					goods.push({
						id: g.id,
						price: g.price,
						limit: g.limit ?? 1,
						bought: bought.get(`${key}|${g.id}`) ?? 0,
						preview: await g.preview(api, random()),
					});
				return { node: here.node.id, goods };
			},
		});

		/* ----- views ---------------------------------------------------------------------- */

		ctx.statics.add({
			id: 'trade-routes.routes',
			compute: ({ rules: view }): TradeRoutesStatic => ({
				// The generals made in full, for the browser to show (name, level, attributes, build).
				orders: [...droppable.values()],
				routes: routesOf(view).map((r) => ({
					...r,
					nodes: r.nodes.map((n) =>
						n.generals ? { ...n, generals: n.generals.map((g, i) => (g ? npcHeroes.make(view, g, generalSeed(r.id, n.id, i)) : null)) } : n,
					),
				})),
				rules: allRules(view),
				trade: trade.get(view) as TradeDealRules,
				budgets: budgets.get(view),
				auxiliaries: [...auxiliaries],
				values: Object.fromEntries(resources.list().map((d) => [d.id, resources.value(view, d.id)])),
			}),
		});
		// The page: the routes' maps, the team, its fights and merchants (web/plugins/trade-routes).
		ctx.services.get('ui').page({
			id: 'trade-routes',
			label: 'Trade Routes',
			order: 6.8,
			widget: 'trade-routes.page',
			props: {
				view: 'trade-routes.state',
				views: ['trade-routes.battle', 'trade-routes.merchant', 'heroes.roster', 'troops.state', 'shop.wallet'],
			},
		});
		ctx.views.add({
			id: 'trade-routes.state',
			quiet: true,
			stamp: playerStamp,
			async compute(api): Promise<TradeRoutesState> {
				const e = await loadExpedition(api, api.playerId);
				const cleared = await loadCleared(api, api.playerId);
				const expedition =
					e && e.endsAt > api.now
						? (({ lastBattle, recalled, ...rest }) => ({
								...rest,
								fought: !!lastBattle,
								...(recalled ? { recalled: true as const } : {}),
							}))(e)
						: null;
				return {
					expedition,
					cleared: Object.fromEntries([...cleared].map(([route, nodes]) => [route, [...nodes]])),
					trade: {
						used: [...(await loadUsed(api, api.playerId))],
						unlocked: [...(await loadUnlocked(api, api.playerId))],
						lossPoints: (await opened(api, api.playerId)).loss,
						// Done ones are done, written or not yet (a view's sync writes nothing).
						deals: [...(await loadDeals(api, api.playerId)).values()].filter((d) => d.finishesAt > api.now),
					},
				};
			},
		});
		// The last fight, every strike of it, for the browser to play (asked for when it shows one, not with every sync).
		ctx.views.add({
			id: 'trade-routes.battle',
			quiet: true,
			stamp: playerStamp,
			async compute(api): Promise<TradeBattleReport | null> {
				return (await loadExpedition(api, api.playerId))?.lastBattle ?? null;
			},
		});
	},
});
