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
	fightable,
	guarded,
	type NodeKind,
	neighbours,
	pathCost,
	FEATURE_KINDS,
	type RouteDef,
	type RouteFeature,
	type RouteNode,
	type GoodsPreview,
	type TradeMerchant,
	type TradeBattleReport,
	type TradeDealRules,
	type TradeOrderDef,
	type TradeDeal,
	tradeLoss,
	tradePair,
	tradePrice,
	tradeQuotas,
	tradeQueues,
	tradeSeconds,
	type TradeColumn,
	type TradeRoutesState,
	type TradeRoutesStatic,
	type TradeRules,
	travelPath,
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
const KINDS: readonly NodeKind[] = ['start', 'enemy', 'boss', 'supply', 'merchant', 'key', 'story', 'lair'];

export interface TradeRoutesService {
	/**
	 * Routes from three tables. `routes`: id, name (a text key), order, chapters (their titles' text keys, "; " between). `nodes`: route, id, chapter, kind (start | enemy |
	 * boss | supply | merchant | key | story; one start a route), x, y (0-1000), width (1-3), enemies (columns front first,
	 * "|" between them, each "unit:n; unit:n"), pool and loot (its reward pool, what a victory draws at least), exp (each
	 * hero's with a victory), name and text (text keys: its name on the map, its story), portrait (who the story shows: an id the browser's art knows), unlock (what clearing it opens for trade: "order:stone>wood:10000;
	 * loss:50"), generals (each enemy column's general by the columns' order, "|" between them, each an NPC hero
	 * "<venue>/<venue level>/<level>", e.g. "tavern/3/45", or empty for none). `edges`: route, a, b.
	 */
	/** `features` (optional): the land each chapter is drawn on (route, chapter, kind, points "x y; x y"). */
	defineFromCsv(routes: string, nodes: string, edges: string, features?: string): void;
	/** A unit that may go along besides the heroes' columns (e.g. supply trains, field surgeons), shared by the team. */
	allowAuxiliary(unit: string): void;
	/** How an attribute counts towards a hero's men (others: rule `capOther`), e.g. { leadership: 10 }. */
	weighAttributes(weights: Record<string, number>): void;
	/** Which attributes make a hero pick the enemy it counters (rule `aimAttrs`), e.g. { strategy: 1 }. */
	weighAim(weights: Record<string, number>): void;
	/** Listen for places won the first time (e.g. what a place gives the first time: the content's own table). */
	onFirstWin(listener: FirstWinListener): void;
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
	/**
	 * The places the player has won, "<route>/<node>" (this one too): e.g. a thing that drops only once the place it
	 * first turns up at was won (user 2026-11-20: "首次节点首次必掉落，之后就能在后面的节点处随机掉落了").
	 */
	cleared: ReadonlySet<string>;
}

/** A place won for the first time (`tradeRoutes.onFirstWin`): what the content gives for it, shown with the fight. */
export type FirstWinListener = (
	api: EngineApi,
	won: { playerId: string; route: string; node: string; settlement: string },
) => Promise<RewardLine[]>;

export interface GoodsDef {
	id: string;
	/** In coupons (元宝). */
	price: number;
	/** How likely it is among the day's goods; 0: there every day. */
	weight: number;
	/**
	 * A place ("<route>/<node>") the player must have won before any merchant has it (user 2026-11-20: "没有经过首次
	 * 出现的节点的时候，相应的商店节点也永不刷新相关道具"); none: from the start.
	 */
	after?: string;
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
export function parseRoutes(
	routesCsv: string,
	nodesCsv: string,
	edgesCsv: string,
	bad: (msg: string) => Error,
	featuresCsv = '',
): RouteDef[] {
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
			...(n.after ? { after: n.after } : {}),
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
	// The land each chapter is drawn on: route, chapter, kind, points ("x y; x y; ...").
	for (const f of csvRows(featuresCsv)) {
		const route = routes.get(f.route);
		if (!route) throw bad(`features: unknown route "${f.route}"`);
		const kind = f.kind as RouteFeature['kind'];
		if (!FEATURE_KINDS.includes(kind)) throw bad(`features: "${f.route}" has no kind "${f.kind}"`);
		const points = (f.points ?? '')
			.split(';')
			.map((p) => p.trim())
			.filter(Boolean)
			.map((p) => p.split(/\s+/).map(Number) as [number, number]);
		if (points.length < 2 || points.some((p) => p.length !== 2 || !p.every(Number.isFinite)))
			throw bad(`features: "${f.route}" ${f.kind}: points are "x y; x y; ..."`);
		(route.features ??= []).push({ chapter: csvNumber(f, 'chapter', 1), kind, points });
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
	raided: string[];
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
		'trade_routes_shipments',
		'trade_routes_traded',
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
		const firstWins: FirstWinListener[] = [];
		/** The places a player won, "<route>/<node>". */
		const wonKeys = async (api: ReadApi, playerId: string) =>
			new Set([...(await loadCleared(api, playerId))].flatMap(([route, nodes]) => [...nodes].map((n) => `${route}/${n}`)));
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
		type Combat = TradeBattleRules & { heroShare: number };
		const combat = ctx.config.define('combat', {
			description:
				"Fights on a trade route: pace (a strike's share of attack² / (attack + defence)), miss (chance), spread (each strike's damage up to this share more or less), maxRounds, heroShare (of the blows a column takes, the share its hero bears: the men take the rest; the men lost as a battle's, gameplay.md §3.8).",
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
				'Routes the GM adds: { "routes": "<csv>", "nodes": "<csv>", "edges": "<csv>", "features"?: "<csv>" } in the format of the content\'s (docs/design/gameplay.md §17.2).',
			default: () => ({ routes: '', nodes: '', edges: '' }),
			parse(raw) {
				const r = shape({
					routes: fields.text({ max: 1e6 }),
					nodes: fields.text({ max: 1e6 }),
					edges: fields.text({ max: 1e6 }),
					features: fields.optional(fields.text({ max: 1e6 })),
				})(raw);
				const parsed = parseRoutes(r.routes, r.nodes, r.edges, (msg) => fail('bad_config', msg), r.features ?? '');
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
						'SELECT settlement_id, route, node, stamina, started_at, ends_at, team, auxiliaries, supplied, raided, last_battle, recalled FROM trade_routes_expeditions WHERE player_id = ?',
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
						raided: string;
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
								raided: JSON.parse(r.raided ?? '[]') as string[],
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
						`INSERT INTO trade_routes_expeditions (player_id, settlement_id, route, node, stamina, started_at, ends_at, team, auxiliaries, supplied, last_battle, recalled, raided)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
						 ON CONFLICT (player_id) DO UPDATE SET node = excluded.node, stamina = excluded.stamina, ends_at = excluded.ends_at,
						   team = excluded.team, auxiliaries = excluded.auxiliaries, supplied = excluded.supplied, raided = excluded.raided, last_battle = excluded.last_battle,
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
						JSON.stringify(e.raided),
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
			defineFromCsv(routesCsv, nodesCsv, edgesCsv, featuresCsv) {
				for (const route of parseRoutes(routesCsv, nodesCsv, edgesCsv, (msg) => new PluginError(`trade-routes: ${msg}`), featuresCsv)) {
					if (content.some((r) => r.id === route.id)) throw new PluginError(`trade-routes: route "${route.id}" defined twice`);
					content.push(route);
					// Each node's reward pool, for content plugins to fill (`loot.addDrop`).
					for (const n of route.nodes) if (n.pool && guarded(n) && !goodsLists.has(n.pool) && !loot.has(n.pool)) loot.definePool(n.pool);
				}
			},
			allowAuxiliary: (unit) => void auxiliaries.add(unit),
			weighAttributes: (w) => void Object.assign(weights, w),
			weighAim: (w) => void Object.assign(aimWeights, w),
			onFirstWin: (listener) => void firstWins.push(listener),
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
				// Teams set out from a trade post (gameplay.md §17.2: "任意城池的外城，建立'开拓据点'开启"; user 2026-11-20:
				// "没有建开拓营地的城池也能派出部队" was a bug).
				const holder = settlements.entity(settlement.id);
				await timeline.sync(api, holder); // a trade post just built
				if ((await stats.get(api, POST_LEVEL, holder)) < 1) throw fail('blocked', 'This settlement has no trade post');
				if (!budgets.get(api).includes(hours)) throw fail('bad_payload', 'Not a budget to choose from');
				if (team.length > r.maxHeroes) throw fail('bad_payload', text('{0} heroes at most', { 0: r.maxHeroes }));
				if (new Set(team.map((c) => c.hero)).size !== team.length) throw fail('bad_payload', 'A hero only once');
				// Each column: a hero of this settlement, free to go, leading one family, no more than it may.
				const all: Record<string, number> = {};
				for (const c of team) {
					const hero = await heroes.requireOwned(api, api.playerId, c.hero);
					// Idle heroes only (user 2026-11-20: "已有任职的英雄不应出现在商路的派出界面"): one in office stays there.
					if (hero.duty !== 'idle') throw fail('blocked', 'Only idle heroes can set out');
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
					raided: [],
					lastBattle: null,
					recalled: false,
				};
				(await expeditionBox(api, api.playerId)).e = e;
				writeExpedition(api, api.playerId, e);
				scheduleReturn(api, api.playerId, e);
			},
		});

		/** Arrived at a node: nothing to fight there clears it; a cleared supply point gives once each time out. */
		/** The team at a place: an unguarded one won by being there; a supply point gives once a time out. True: it gave. */
		async function arrive(api: EngineApi, e: Expedition, route: RouteDef, to: string, reschedule = true) {
			const node = route.nodes.find((n) => n.id === to)!;
			e.node = to;
			if (!guarded(node)) await clear(api, api.playerId, route.id, to);
			if (node.kind === 'supply' && !e.supplied.includes(to)) {
				e.supplied.push(to);
				gain(api, e, allRules(api).supplyPass);
				if (reschedule) scheduleReturn(api, api.playerId, e);
				return true;
			}
			return false;
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

		// A long way over opened ground in one go (user 2026-11-20: "后端也要有快捷方式，不要每移动一格都写一次表"): the
		// shortest, step by step as walking it would be (what supply points give on the way counts), written once.
		ctx.commands.add<{ node: string }>({
			type: 'trade-routes.travel',
			description:
				'Walk the team to a place won before, the shortest way over places won (a third of the stamina a path; supply points on the way give as passing does). Payload: { "node" }',
			parse: shape({ node: fields.id() }),
			async execute(api, { node: to }) {
				const r = allRules(api);
				const e = await onTheRoad(api);
				const route = routeOf(api, e.route);
				const cleared = await loadCleared(api, api.playerId);
				const way = travelPath(route, (n) => isCleared(cleared, route, n), e.node, to, r);
				if (!way || !way.path.length) throw fail('bad_payload', 'No way over opened ground to there');
				let gave = false;
				for (const step of way.path) {
					const cost = pathCost(r, true);
					if (e.stamina + 1e-9 < cost) throw fail('tired', 'Not enough stamina');
					e.stamina -= cost;
					gave = (await arrive(api, e, route, step, false)) || gave;
				}
				if (gave) scheduleReturn(api, api.playerId, e);
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
				// A man's hp bonus, for its deaths as a battle's.
				hpMultiplier: n.hpMultiplier,
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
				// A neighbour, or the lair the team stands at (beaten before, back again).
				const atLair = target?.kind === 'lair' && target.id === e.node;
				if (!target || !(atLair || neighbours(route, e.node).includes(to))) throw fail('bad_payload', 'Not a neighbouring node');
				const cleared = await loadCleared(api, api.playerId);
				const wonBefore = isCleared(cleared, route, to);
				if (!fightable(target, wonBefore, e.raided)) throw fail('blocked', 'Nothing to fight there');
				if (new Set(sent).size !== sent.length) throw fail('bad_payload', 'A hero only once');
				if (sent.length > target.width) throw fail('bad_payload', text('{0} columns fight here at most', { 0: target.width }));
				const columns = sent.map((h) => {
					const c = e.team.find((x) => x.hero === h);
					if (!c || !Object.values(c.units).some((n) => n > 0)) throw fail('bad_payload', 'Not a column of the team');
					return c;
				});
				// The path at full cost (a place not won), or the way back into a lair won before (both ends won), or none (at it).
				const cost = (atLair ? 0 : pathCost(r, wonBefore && isCleared(cleared, route, e.node))) + r.battle;
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
				// The surgeons who came along, at work as the fight goes (battle.recovery: a share of each round's fallen).
				const everyone: Record<string, number> = { ...e.auxiliaries };
				for (const col of e.team) for (const [u, n] of Object.entries(col.units)) everyone[u] = (everyone[u] ?? 0) + n;
				const side: BattleSide = { role: 'attacker', playerId: api.playerId, settlement: home, heroes: sent };
				const recovery = await battle.recovery(api, side, everyone);
				const recover = recovery
					? {
							share: recovery.share,
							men: recovery.men,
							hpPerMan: Object.fromEntries(
								columns.map((col, i) => [
									col.hero,
									ours[i].hp /
										Math.max(
											1,
											Object.values(col.units).reduce((a, b) => a + b, 0),
										),
								]),
							),
						}
					: undefined;
				const log: TradeBattleLog = fightColumns(ours, theirs, target.width, c, random, (a, b) => battle.counters(a, b), recover);

				// The men who fought, as they were at the start (for promotions).
				const fought: Record<string, number> = {};
				for (const col of columns) for (const [u, n] of Object.entries(col.units)) if (n > 0) fought[u] = (fought[u] ?? 0) + n;
				// Deaths as in every battle (user 2026-11-20: "互砍时的受伤系统……如果主战斗系统合理，可以复用之"; gameplay.md §3.8):
				// each column's hp lost is the damage it took, flat hp a buffer taken first, the rest shared by head over its
				// tiers (the lower fall first); then the result's factor, as the battle grades a side: won with most of its
				// hp left a crushing victory, with some a victory, barely a narrow one; beaten back, a rout (they get away);
				// and the side's casualty bonuses. The surgeons worked during the fight (the hp they brought back is in `left`).
				const hpAll = columns.reduce((a, _col, i) => a + ours[i].hp, 0) || 1;
				const leftAll = columns.reduce((a, col) => a + (log.left[col.hero] ?? 0), 0);
				const grade = !log.won ? 'routed' : leftAll / hpAll >= 0.7 ? 'crushing' : leftAll / hpAll >= 0.3 ? 'victory' : 'narrow';
				const factor = battle.resultFactor(api, grade);
				// Those who fell and stood up again (the surgeons) count for promotions all the same ("复活的士兵也提供晋升额度").
				const fallenOf = (col: TradeColumn, i: number, hpGone: number) => {
					const family =
						Object.keys(col.units)
							.map((u) => troops.get(u)?.family)
							.find(Boolean) ?? '';
					// The hero takes a fixed share of the blows (user 2026-11-20: "让英雄的血量做缓冲有点奇怪。改成固定最多40%的伤害
					// 由英雄承担"), the men the rest.
					const dead = battle.spreadDeaths(api, { family, units: col.units }, hpGone * (1 - c.heroShare), ours[i].hpMultiplier);
					return Object.fromEntries(
						Object.entries(col.units).map(([u, n]) => [u, Math.min(n, Math.round((dead[u] ?? 0) * factor * ours[i].casualty))]),
					);
				};
				const losses: Record<string, number> = {};
				const lost: Record<string, Record<string, number>> = {};
				let fallenAll = 0;
				let lostAll = 0;
				for (const [i, col] of columns.entries()) {
					const gone = ours[i].hp - (log.left[col.hero] ?? 0);
					const fell = fallenOf(col, i, gone + (log.healed?.[col.hero] ?? 0));
					const down = fallenOf(col, i, gone);
					lost[col.hero] = {};
					for (const [u, n] of Object.entries(fell)) if (n) ((losses[u] = (losses[u] ?? 0) + n), (fallenAll += n));
					for (const [u, n] of Object.entries(down)) {
						if (!n) continue;
						lost[col.hero][u] = n;
						col.units[u] -= n;
						lostAll += n;
					}
				}
				const final = {
					losses: Object.fromEntries(
						Object.entries(lost)
							.flatMap(([, units]) => Object.entries(units))
							.reduce((m, [u, n]) => m.set(u, (m.get(u) ?? 0) + n), new Map<string, number>()),
					),
					adjustments: recovery && fallenAll > lostAll ? [{ source: recovery.source, before: fallenAll, after: lostAll }] : [],
				};

				// Promotions as in every battle (user 2026-11-20: "商路开拓时的晋升要和主要战斗保持一致"; gameplay.md §2.6): the
				// battle's own reckoning over the columns that fought, the fallen before the surgeons counting; a fight beaten
				// back is a rout (none). Each promotion goes to the columns that have survivors of its unit.
				const promoted: TradeBattleReport['promoted'] = [];
				if (log.won) {
					const cost = await stats.get(api, 'battle.promotionCost', `player:${api.playerId}`);
					for (const p of battle.promotions(fought, final.losses, cost, losses)) {
						let left = p.count;
						for (const col of columns) {
							const k = Math.min(left, col.units[p.from] ?? 0);
							if (k <= 0) continue;
							col.units[p.from] -= k;
							col.units[p.to] = (col.units[p.to] ?? 0) + k;
							left -= k;
							promoted.push({ hero: col.hero, from: p.from, to: p.to, count: k });
							if (!left) break;
						}
					}
				}

				const report: TradeBattleReport = {
					node: to,
					log,
					lost,
					saved: final.adjustments,
					rewards: [],
					exp: 0,
					epiphanies: {},
					...(promoted.length ? { promoted } : {}),
				};
				if (log.won) {
					await clear(api, api.playerId, route.id, to);
					if (target.kind === 'lair') e.raided.push(to);
					if (!atLair) await arrive(api, e, route, to);
					// What the content gives for a place won the first time (a lair fought again gives only what it drops).
					if (!wonBefore)
						for (const listener of firstWins)
							report.rewards.push(
								...(await listener(api, { playerId: api.playerId, route: route.id, node: to, settlement: e.settlement })),
							);
					if (target.kind === 'supply') gain(api, e, r.supplyFirst);
					// What it drops, the experience of those who fought, maybe an epiphany.
					if (target.pool && loot.has(target.pool) && !loot.empty(target.pool)) {
						const occasion: TradeLootOccasion & { playerId: string; random: () => number } = {
							playerId: api.playerId,
							route: route.id,
							node: to,
							chapter: target.chapter,
							settlement: e.settlement,
							cleared: await wonKeys(api, api.playerId),
							random,
						};
						const ids = await loot.roll(api, target.pool, occasion, target.loot ?? 1, random);
						report.rewards.push(...(await loot.give(api, target.pool, ids, occasion)));
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
		/** Bought today, by direction (`tradePair`). */
		const loadTraded = (api: ReadApi, playerId: string) =>
			api.memo(`trade-routes:traded:${playerId}:${today(api)}`, async () => {
				const { results } = await api.db
					.prepare('SELECT pair, amount FROM trade_routes_traded WHERE player_id = ? AND day = ?')
					.bind(playerId, today(api))
					.all<{ pair: string; amount: number }>();
				return new Map(results.map((r) => [r.pair, r.amount]));
			});
		/** The player's deals under way, by id (several at a post: user 2026-11-25: "可以并行N个队列"). */
		const loadDeals = (api: ReadApi, playerId: string) =>
			api.memo(`trade-routes:deals:${playerId}`, async () => {
				const { results } = await api.db
					.prepare('SELECT id, settlement_id, resource, amount, started_at, finishes_at FROM trade_routes_shipments WHERE player_id = ?')
					.bind(playerId)
					.all<{ id: string; settlement_id: string; resource: string; amount: number; started_at: number; finishes_at: number }>();
				return new Map<string, TradeDeal>(
					results.map((r) => [
						r.id,
						{
							id: r.id,
							settlement: r.settlement_id,
							resource: r.resource,
							amount: r.amount,
							startedAt: r.started_at,
							finishesAt: r.finishes_at,
						},
					]),
				);
			});

		ctx.commands.add<{ settlement: string; from: string; to: string; amount: number }>({
			type: 'trade-routes.trade',
			description:
				'Trade at a settlement\'s trade post: buy `amount` of `to` with `from`, within today\'s quota that way (the orders opened that way, added up); pay now (by the resources\' values, plus the loss), have it when the deal is done. A post runs several deals at once. Payload: { "settlement", "from", "to", "amount" }',
			parse: shape(
				{
					settlement: fields.id(),
					from: fields.oneOf(() => resources.list().map((d) => d.id)),
					to: fields.oneOf(() => resources.list().map((d) => d.id)),
					amount: fields.int(1, 1e9),
				},
				(p) => {
					if (p.from === p.to) throw fail('bad_payload', 'from and to must differ');
					return p;
				},
			),
			async execute(api, { settlement: settlementId, from, to, amount }) {
				const settlement = await settlements.requireOwned(api, settlementId);
				const holder = settlements.entity(settlement.id);
				await timeline.sync(api, holder); // what is due there first (a trade post just built or raised, deals done)
				const level = await stats.get(api, POST_LEVEL, holder);
				if (level < 1) throw fail('blocked', 'This settlement has no trade post');
				// Today's quota that way: the orders opened that way, added up (user 2026-11-25: "把这些商单全部加起来，作为每日上限，玩家可以自由选择数量").
				const { orders, loss } = await opened(api, api.playerId);
				const pair = tradePair(from, to);
				const quota = tradeQuotas(orders)[pair] ?? 0;
				if (!quota) throw fail('not_found', 'No trade order of yours goes this way', 404);
				const traded = await loadTraded(api, api.playerId);
				const left = quota - (traded.get(pair) ?? 0);
				if (amount > left) throw fail('blocked', text("Only {0} left of today's quota in this direction", { 0: Math.max(0, left) }));
				// Side by side, each its own timer (user 2026-11-25: "可以并行N个队列（不是串行）"; "最低3，每三级多一个").
				const r = trade.get(api) as TradeDealRules;
				const deals = await loadDeals(api, api.playerId);
				const queues = tradeQueues(r, level);
				if ([...deals.values()].filter((d) => d.settlement === settlement.id && d.finishesAt > api.now).length >= queues)
					throw fail('busy', text('This trade post runs {0} deals at once', { 0: queues }));
				const price = tradePrice(amount, resources.value(api, from), resources.value(api, to), tradeLoss(r, loss));
				await resources.spend(api, holder, { [from]: price });
				const deal: TradeDeal = {
					id: crypto.randomUUID(),
					settlement: settlement.id,
					resource: to,
					amount,
					startedAt: api.now,
					finishesAt: api.now + tradeSeconds(r, level) * 1000,
				};
				traded.set(pair, (traded.get(pair) ?? 0) + amount);
				deals.set(deal.id, deal);
				api.write(
					api.db
						.prepare(
							'INSERT INTO trade_routes_traded (player_id, day, pair, amount) VALUES (?, ?, ?, ?) ON CONFLICT (player_id, day, pair) DO UPDATE SET amount = excluded.amount',
						)
						.bind(api.playerId, today(api), pair, traded.get(pair)),
				);
				api.write(
					api.db
						.prepare(
							'INSERT INTO trade_routes_shipments (id, settlement_id, player_id, resource, amount, started_at, finishes_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
						)
						.bind(deal.id, settlement.id, api.playerId, deal.resource, deal.amount, deal.startedAt, deal.finishesAt),
				);
				timeline.schedule(api, holder, deal.finishesAt, DEAL, { id: deal.id, player: api.playerId });
				// Its id only: the browser knows the rest (what it asked for, the post's level and the rules).
				api.reply('trade-routes.deal', deal.id);
			},
		});
		// A deal done: what was bought comes in. (Deals made before several ran at once have their settlement for an id:
		// migration 0043 moved them so.)
		timeline.on<{ id?: string; settlement?: string; player: string }>(DEAL, async (api, event) => {
			const deals = await loadDeals(api, event.payload.player);
			const id = event.payload.id ?? event.payload.settlement ?? '';
			const deal = deals.get(id);
			if (!deal) return;
			await resources.add(api, settlements.entity(deal.settlement), deal.resource, deal.amount);
			deals.delete(id);
			api.write(api.db.prepare('DELETE FROM trade_routes_shipments WHERE id = ?').bind(id));
		});

		/* ----- merchants ---------------------------------------------------------------------- */

		/** A merchant's goods today for the player: the ones always there and `count` drawn by weight, each with its seed. */
		function stockOf(api: ReadApi, playerId: string, route: string, node: RouteNode, won: ReadonlySet<string>) {
			// Its goods list: the `goods` column (a merchant guarded like every place has a loot pool too), else its pool;
			// what is new to the routes only once the place it first turns up at was won.
			const listId = node.goods ?? node.pool;
			const list = (listId ? (goodsLists.get(listId) ?? []) : []).filter((g) => !g.after || won.has(g.after));
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
				const item = stockOf(api, api.playerId, here.route.id, here.node, await wonKeys(api, api.playerId)).find(
					(x) => x.goods.id === goodsId,
				);
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
				for (const { goods: g, random } of stockOf(api, api.playerId, here.route.id, here.node, await wonKeys(api, api.playerId)))
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
						traded: Object.fromEntries(await loadTraded(api, api.playerId)),
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
