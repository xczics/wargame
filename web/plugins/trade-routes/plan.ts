// What the trade routes' screens work out in the browser from the static routes and the player's state: the same
// rules as the server (src/shared/trade-routes.ts), which checks everything again. Pure: the tests run it.
import type { UnitCatalog } from '../../../src/shared/api';
import {
	type RouteDef,
	type RouteNode,
	type TradeRoutesState,
	type TradeRules,
	guarded,
	neighbours,
	pathCost,
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
	if (!e || e.route !== route.id || !neighbours(route, e.node).includes(node.id)) return null;
	const open = cleared(state, route, node.id);
	if (guarded(node) && !open) {
		const cost = pathCost(rules, false) + rules.battle;
		return { kind: 'fight' as const, cost, short: e.stamina + 1e-9 < cost };
	}
	const cost = pathCost(rules, open && cleared(state, route, e.node));
	return { kind: 'move' as const, cost, short: e.stamina + 1e-9 < cost };
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
