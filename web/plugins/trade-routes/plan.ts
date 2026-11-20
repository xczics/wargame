// What the trade routes' screens work out in the browser from the static routes and the player's state: the same
// rules as the server (src/shared/trade-routes.ts), which checks everything again. Pure: the tests run it.
import type { UnitCatalog } from '../../../src/shared/api';
import {
	type RouteDef,
	type RouteNode,
	type TradeRoutesState,
	type TradeRules,
	fightable,
	neighbours,
	pathCost,
	travelPath,
} from '../../../src/shared/trade-routes';

/** A portrait's pixels: rows of palette letters ("." clear), 32x32 (the art: client content plugins). */
export interface PortraitArt {
	rows: string[];
	palette: Record<string, string>;
}

export const startOf = (route: RouteDef) => route.nodes.find((n) => n.kind === 'start')!;

/** Whether a node of a route is cleared (the start always is). */
export const cleared = (state: TradeRoutesState | undefined, route: RouteDef, node: string) =>
	node === startOf(route).id || !!state?.cleared[route.id]?.includes(node);

/** How far the player has come on a route: cleared nodes of all but the start, and the furthest chapter reached. */
export function progress(state: TradeRoutesState | undefined, route: RouteDef) {
	const nodes = route.nodes.filter((n) => n.kind !== 'start');
	const done = nodes.filter((n) => cleared(state, route, n.id));
	const chapter = Math.max(1, ...done.map((n) => n.chapter + (n.kind === 'boss' ? 1 : 0)));
	return { done: done.length, of: nodes.length, chapter: Math.min(chapter, route.chapters.length || chapter) };
}

/**
 * Whether a node shows on the map: cleared ones, and those next to a cleared one (the fog hides the rest: the net is
 * found by walking it).
 */
export function visible(state: TradeRoutesState | undefined, route: RouteDef, node: RouteNode) {
	if (cleared(state, route, node.id)) return true;
	return neighbours(route, node.id).some((n) => cleared(state, route, n));
}

/** What the team can do with a neighbouring node from where it stands: walk there, fight for it, or nothing. */
export function stepTo(state: TradeRoutesState | undefined, route: RouteDef, rules: TradeRules, node: RouteNode) {
	const e = state?.expedition;
	if (!e || e.route !== route.id) return null;
	const open = cleared(state, route, node.id);
	// The lair the team stands at, beaten before: fight it again where it is.
	if (node.id === e.node)
		return node.kind === 'lair' && fightable(node, open, e.raided ?? [])
			? { kind: 'fight' as const, cost: rules.battle, short: e.stamina + 1e-9 < rules.battle }
			: null;
	if (!neighbours(route, e.node).includes(node.id)) return null;
	if (fightable(node, open, e.raided ?? [])) {
		const cost = pathCost(rules, open && cleared(state, route, e.node)) + rules.battle;
		return { kind: 'fight' as const, cost, short: e.stamina + 1e-9 < cost };
	}
	const cost = pathCost(rules, open && cleared(state, route, e.node));
	return { kind: 'move' as const, cost, short: e.stamina + 1e-9 < cost };
}

/**
 * What the team can do with any place from where it stands, the long way too (user 2026-11-20: "自动按已开拓的最短路径
 * 移动过去"): a neighbour as `stepTo` says; a place won, travelled to over opened ground; a place not won (or a lair to
 * fight again) next to opened ground, travelled to the best place beside it (`from`, unless the team is there) and
 * fought for. `via`: how many places the travel passes.
 */
export function reachTo(state: TradeRoutesState | undefined, route: RouteDef, rules: TradeRules, node: RouteNode) {
	const near = stepTo(state, route, rules, node);
	if (near) return { ...near, via: 0, from: undefined as string | undefined };
	const e = state?.expedition;
	if (!e || e.route !== route.id) return null;
	const won = (id: string) => cleared(state, route, id);
	const short = (cost: number) => e.stamina + 1e-9 < cost;
	if (won(node.id) && !fightable(node, true, e.raided ?? [])) {
		const way = travelPath(route, won, e.node, node.id, rules);
		return way ? { kind: 'travel' as const, cost: way.cost, short: short(way.cost), via: way.path.length, from: undefined } : null;
	}
	if (!fightable(node, won(node.id), e.raided ?? [])) return null;
	// A lair won before: go to it and fight it there. A place not won: from the cheapest place beside it.
	if (won(node.id)) {
		const way = travelPath(route, won, e.node, node.id, rules);
		if (!way) return null;
		const cost = way.cost + rules.battle;
		return { kind: 'fight' as const, cost, short: short(cost), via: way.path.length, from: node.id };
	}
	let best: { cost: number; via: number; from: string } | null = null;
	for (const n of neighbours(route, node.id)) {
		if (!won(n)) continue;
		const way = travelPath(route, won, e.node, n, rules);
		if (!way) continue;
		const cost = way.cost + pathCost(rules, false) + rules.battle;
		if (!best || cost < best.cost) best = { cost, via: way.path.length, from: n };
	}
	return best ? { kind: 'fight' as const, cost: best.cost, short: short(best.cost), via: best.via, from: best.from } : null;
}

/** Upkeep for a budget of `hours` (as the server charges it: by the settlement's upkeep factor), by resource. */
export function budgetCost(units: Record<string, number>, catalog: UnitCatalog, hours: number, factor: number) {
	const cost: Record<string, number> = {};
	for (const [u, n] of Object.entries(units))
		for (const [res, perSecond] of Object.entries(catalog[u]?.upkeep ?? {}))
			cost[res] = (cost[res] ?? 0) + perSecond * n * 3600 * hours * factor;
	for (const res of Object.keys(cost)) cost[res] = Math.ceil(cost[res]);
	return cost;
}

/** What the units carry together. */
export const carryOf = (units: Record<string, number>, catalog: UnitCatalog) =>
	Object.entries(units).reduce((a, [u, n]) => a + (catalog[u]?.carry ?? 0) * n, 0);

/** Units summed over the team's columns and the auxiliaries. */
export function everyone(team: { units: Record<string, number> }[], auxiliaries: Record<string, number>) {
	const all: Record<string, number> = { ...auxiliaries };
	for (const c of team) for (const [u, n] of Object.entries(c.units)) if (n > 0) all[u] = (all[u] ?? 0) + n;
	return all;
}

/** Strikes up to `at` (in order), and the hp each column has left then. */
export function replay(
	log: { ours: { id: string; hp: number }[]; theirs: { id: string; hp: number }[]; strikes: { to: string; damage: number }[] },
	at: number,
) {
	const hp: Record<string, number> = {};
	for (const c of [...log.ours, ...log.theirs]) hp[c.id] = c.hp;
	for (const s of log.strikes.slice(0, at)) hp[s.to] = Math.max(0, hp[s.to] - s.damage);
	return hp;
}

/** The enemy columns at the front after the strikes up to `at`: the first `width`, the fallen replaced from the reserve. */
export function frontAt(
	log: { width: number; theirs: { id: string }[]; strikes: { side: string; to: string; fell?: true; next?: string }[] },
	at: number,
) {
	const front = log.theirs.slice(0, log.width).map((c) => c.id);
	for (const s of log.strikes.slice(0, at))
		if (s.side === 'ours' && s.fell) {
			const i = front.indexOf(s.to);
			if (i < 0) continue;
			if (s.next) front[i] = s.next;
			else front.splice(i, 1);
		}
	return front;
}
