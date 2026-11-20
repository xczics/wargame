/**
 * Trade routes (docs/design/gameplay.md §17.2): the routes' maps, the rules of stamina and the team, as the server and
 * the browser both go by them. Pure.
 */
import type { RewardLine } from './api';
import type { NpcHero, NpcHeroSpec } from './npc-heroes';
import type { TradeBattleLog } from './trade-battle';
import type { UiText } from './ui';

/** What stands at a node. */
export type NodeKind = 'start' | 'enemy' | 'boss' | 'supply' | 'merchant' | 'key' | 'story';

export interface RouteNode {
	id: string;
	chapter: number;
	kind: NodeKind;
	/** Where it is drawn on the route's map (0-1000 each way). */
	x: number;
	y: number;
	/** How many of the team's columns fight here at once (1-3; a boss 3). */
	width: number;
	/** The enemy columns, front first: each a column's units ("<unit>": count). None: nothing to fight. */
	enemies: Record<string, number>[];
	/**
	 * Each enemy column's general, by the columns' order (user 2026-11-18: "普通小兵，一开始群龙无首……越往后面敌方英雄也越
	 * 牛逼"): an NPC hero's spec (npc-heroes), made in full (attributes, name) in the static view and in the fight, counted
	 * like a hero's (nothing worn); null or left out: no one leads it.
	 */
	generals?: (TradeGeneral | null)[];
	/** Its reward pool (the loot plugin's), if it has one, and what a victory draws from it at least. */
	pool?: string;
	loot?: number;
	/** A merchant's goods list (`tradeRoutes.addGoods`); none: its `pool` names it (before every place was guarded). */
	goods?: string;
	/** Experience each hero who fought gains with a victory. */
	exp?: number;
	/**
	 * Its name on the map and its story, text keys (the content plugin's): `text` what is seen before its guards are
	 * fought (what happened here, who holds it), `after` how it ends once they are beaten (user 2026-11-20: "剧情有两部分：
	 * 打之前给看一部分……打完之后，再补全剩下的部分", e.g. the place at peace again, the shop open again).
	 */
	name?: string;
	text?: string;
	after?: string;
	/** Who the story shows there: a portrait's id (the art comes from a client content plugin). */
	portrait?: string;
	/**
	 * A supply point's words, text keys: when its guards are beaten and their stores taken (`first`), and when the team
	 * passes again and is given what it needs (`pass`; user 2026-11-20: "首次解锁时查抄了路霸的存货，后面再次路过时当地百姓
	 * 的爱戴、或我们经营得当").
	 */
	first?: string;
	pass?: string;
	/** What clearing it opens for trade: orders (a day's deal each) and points off the loss. */
	unlock?: { orders: TradeOrderDef[]; loss: number };
}

/** An enemy column's general: its spec, and once made (the static view) its attributes, name and build. */
export type TradeGeneral = NpcHeroSpec & Partial<Omit<NpcHero, keyof NpcHeroSpec>>;

/** A trade order a key node opens: `amount` of `to` a day, paid in `from` (by their values, plus the loss). */
export interface TradeOrderDef {
	id: string;
	from: string;
	to: string;
	amount: number;
}

/** Trade rules (`trade-routes.trade`). */
export interface TradeDealRules {
	minutes: number;
	floor: number;
	perLevel: number;
	upTo: number;
	beyond: number;
	loss: number;
}

export interface RouteDef {
	id: string;
	/** A text key. */
	name: string;
	order: number;
	/** Its chapters' titles, text keys (chapter 1 first). */
	chapters: string[];
	nodes: RouteNode[];
	/** Paths between nodes, both ways. */
	edges: [string, string][];
}

/** Stamina and team rules (`trade-routes.rules`). */
export interface TradeRules {
	/** Stamina an hour of budget gives (and what an hour more on the road takes). */
	perHour: number;
	/** Walking a path... */
	edge: number;
	/** ...this share of it on a path both of whose ends are cleared. */
	clearedShare: number;
	/** A fight. */
	battle: number;
	/** A supply point won (its guards beaten), once... */
	supplyFirst: number;
	/** ...and passing one cleared, once each time out. */
	supplyPass: number;
	/** Heroes in a team at most. */
	maxHeroes: number;
	/** A hero's men at most: level x capLevel + each attribute x its factor in capAttrs (the others x capOther). */
	capLevel: number;
	capAttrs: Record<string, number>;
	capOther: number;
	/**
	 * How well a column picks the enemy it counters (`aimOf`): its hero's attributes, each x its factor in aimAttrs (e.g.
	 * strategy 1), give aim points; the chance is points / (points + aimHalf). Enemy columns by their general's
	 * attributes; with none, at random.
	 */
	aimAttrs: Record<string, number>;
	aimHalf: number;
}

/** The static view `trade-routes.routes`: the routes, the rules, the budgets to choose from, the auxiliaries allowed. */
export interface TradeRoutesStatic {
	routes: RouteDef[];
	/** Trade orders a fight may open for good (`tradeRoutes.addOrders`). */
	orders: TradeOrderDef[];
	rules: TradeRules;
	/** Trade at a trade post. */
	trade: TradeDealRules;
	/** Hours of budget to choose from. */
	budgets: number[];
	/** Units that may go along besides the heroes' columns (shared by the team). */
	auxiliaries: string[];
	/** The resources' values (`resources.values`): what trade orders cost. */
	values: Record<string, number>;
}

export interface TradeColumn {
	hero: string;
	units: Record<string, number>;
}

/** The view `trade-routes.state`: the player's team on the road (if any), and what the player has cleared. */
export interface TradeRoutesState {
	expedition: {
		route: string;
		settlement: string;
		node: string;
		stamina: number;
		startedAt: number;
		endsAt: number;
		team: TradeColumn[];
		auxiliaries: Record<string, number>;
		/** Supply points that gave this time out. */
		supplied: string[];
		/** A fight to show (view `trade-routes.battle`). */
		fought: boolean;
		/** Called home: on its way back until `endsAt` (no more moves, fights or buying). */
		recalled?: true;
	} | null;
	/** Cleared nodes by route. */
	cleared: Record<string, string[]>;
	/** Trade: the orders filled today, the points off the loss won, the deals under way (by settlement). */
	trade: {
		used: string[];
		/** Orders opened for good by drops in fights (ids of the static view's `orders`). */
		unlocked: string[];
		lossPoints: number;
		deals: { settlement: string; order: string; resource: string; amount: number; startedAt: number; finishesAt: number }[];
	};
}

/** The last fight on a trade route (view `trade-routes.battle`): every strike, what it cost and brought. */
export interface TradeBattleReport {
	node: string;
	log: TradeBattleLog;
	/** Men lost by hero's column, by unit. */
	lost: Record<string, Record<string, number>>;
	/** Who saved how many of the fallen (e.g. surgeons): before and after. */
	saved: { source: UiText; before: number; after: number }[];
	rewards: RewardLine[];
	/** Experience each hero who fought gained. */
	exp: number;
	/** Free points of an epiphany, by hero. */
	epiphanies: Record<string, number>;
}

/**
 * A trade post's trade speed, % (user 2026-11-16: "固定8小时，每级快一点，二十级到1小时，继续突破等级可以继续降低，最后无限趋近于3分钟";
 * "换成某个前端能显示的速度+x%/级的做法"; "复利吧"): perLevel % a level from the second up to upTo, then x beyond a level.
 */
export function tradeSpeed(r: TradeDealRules, level: number): number {
	if (level <= 0) return 0;
	const upTo = r.perLevel * (Math.min(level, r.upTo) - 1);
	return level <= r.upTo ? upTo : ((1 + upTo / 100) * r.beyond ** (level - r.upTo) - 1) * 100;
}
/** How long a deal takes at a trade post of `level`, in seconds: the floor, and the rest sped up. */
export const tradeSeconds = (r: TradeDealRules, level: number) =>
	Math.round((r.floor + (r.minutes - r.floor) / (1 + tradeSpeed(r, level) / 100)) * 60);
/** The loss on a deal: the base, less with every point the routes give, never to nothing ("让每一个损耗降低值都有效，但又不会溢出"). */
export const tradeLoss = (r: TradeDealRules, points: number) => r.loss / (1 + Math.max(0, points) / 100);
/** What a deal costs: `amount` of the order's resource by values, the loss on top (the player bears it). */
export const tradePrice = (order: Pick<TradeOrderDef, 'amount'>, valueFrom: number, valueTo: number, loss: number) =>
	Math.ceil((order.amount * valueTo) / valueFrom / (1 - Math.min(0.99, loss)));

/** What a merchant shows of its goods: as a reward line, a piece's numbers too (user: "能看到颜色和六维的属性，玩家决定买不买"). */
/** A piece's numbers come with its base (meta `equipment.bases`: how its stats are named). */
export type GoodsPreview = Omit<RewardLine, 'lost'> & { stats?: Record<string, number>; base?: string };

/** The view `trade-routes.merchant`: the goods of the merchant where the team stands, today. */
export interface TradeMerchant {
	node: string;
	goods: { id: string; price: number; limit: number; bought: number; preview: GoodsPreview }[];
}

/** Whether there is something to fight at a node. */
export const guarded = (n: RouteNode) => n.enemies.length > 0;

/** Stamina a path takes: less once both its ends are cleared ("已经开拓过的商路……移动时体力值只需1/3"). */
export const pathCost = (rules: TradeRules, cleared: boolean) => (cleared ? rules.edge * rules.clearedShare : rules.edge);

/** How many men a hero leads on a trade route (user 2026-11-16: "按等级*100 + 统率*10 + 魅力 * 5 + 其余之和"). */
export function troopCap(rules: TradeRules, level: number, attrs: Record<string, number>): number {
	let cap = level * rules.capLevel;
	for (const [a, n] of Object.entries(attrs)) cap += n * (rules.capAttrs[a] ?? rules.capOther);
	return Math.floor(cap);
}

/** A hero's chance (0-1) to strike the enemy column it counters when there is one (see TradeRules.aimAttrs). */
export function aimOf(rules: TradeRules, attrs: Record<string, number>): number {
	let points = 0;
	for (const [a, w] of Object.entries(rules.aimAttrs)) points += (attrs[a] ?? 0) * w;
	return points > 0 ? points / (points + (rules.aimHalf || 1)) : 0;
}

/** The node's neighbours on its route. */
export function neighbours(route: RouteDef, node: string): string[] {
	return route.edges.flatMap(([a, b]) => (a === node ? [b] : b === node ? [a] : []));
}
