/**
 * A body of troops' totals from each unit's numbers (the rules' `troops.units`, no bonuses): attack, defence and hp
 * summed, the slowest speed. The server's `troops.totals` (carry for loot, a garrison's strength) and the Army page's
 * strength line (from the static view in the browser) go by it. Pure.
 */
import type { GarrisonInfo, TroopsState, UnitCatalog, UnitNumbers } from './api';

export function unitTotals(
	units: Record<string, number>,
	numbersOf: (unit: string) => Pick<UnitNumbers, 'attack' | 'defense' | 'hp' | 'carry' | 'speed'> | undefined,
) {
	const out = { attack: 0, defense: 0, hp: 0, carry: 0, speed: 0 };
	let slowest = Infinity;
	for (const [unit, n] of Object.entries(units)) {
		const u = n ? numbersOf(unit) : undefined;
		if (!u) continue;
		out.attack += u.attack * n;
		out.defense += u.defense * n;
		out.hp += u.hp * n;
		out.carry += u.carry * n;
		slowest = Math.min(slowest, u.speed);
	}
	out.speed = Number.isFinite(slowest) ? slowest : 0;
	return out;
}

/** How many times `cost` is paid from `stock` (the most of one order the resources pay for; the server's `resources.timesPaid`). */
export const timesPaid = (cost: Record<string, number>, stock: Record<string, number>): number =>
	Math.min(Infinity, ...Object.entries(cost).map(([r, n]) => (n > 0 ? Math.floor(Math.max(0, stock[r] ?? 0) / n) : Infinity)));

/**
 * A garrison's units and upkeep after `moved` left it (negative counts: came in), as the server has them then: the
 * upkeep (the server's per-unit upkeep times one factor of the settlement's) scaled by the base upkeep left. Pure: the
 * browser patches the garrisons it holds by it when a command it sent moved troops (dismissed, marched off).
 */
export function movedUnits<G extends { units: { id: string; count: number }[]; upkeep: Record<string, number> }>(
	g: G,
	moved: Record<string, number>,
	numbersOf: (unit: string) => Pick<UnitNumbers, 'upkeep'> | undefined,
): G {
	if (!Object.values(moved).some((n) => n)) return g;
	const before = Object.fromEntries(g.units.map((u) => [u.id, u.count]));
	const after: Record<string, number> = { ...before };
	for (const [u, n] of Object.entries(moved)) after[u] = Math.max(0, (after[u] ?? 0) - n);
	const base = (counts: Record<string, number>) => {
		const out: Record<string, number> = {};
		for (const [u, n] of Object.entries(counts))
			if (n > 0) for (const [r, per] of Object.entries(numbersOf(u)?.upkeep ?? {})) out[r] = (out[r] ?? 0) + per * n;
		return out;
	};
	const was = base(before);
	const now = base(after);
	const upkeep: Record<string, number> = {};
	// (A resource stays at 0, as the server keeps it for units once there.)
	for (const [r, v] of Object.entries(g.upkeep)) upkeep[r] = was[r] ? (v * (now[r] ?? 0)) / was[r] : v;
	const units = [
		...g.units.map((u) => ({ ...u, count: after[u.id] ?? 0 })),
		...Object.keys(after)
			.filter((id) => !(id in before) && after[id] > 0)
			.map((id) => ({ id, count: after[id] })),
	].filter((u) => u.count > 0);
	return { ...g, units, upkeep } as G;
}

/** Every garrison of `settlement` held in `state` with `moved` gone from it (negative: come in). */
export function stateMoved(
	state: TroopsState,
	settlement: string,
	moved: Record<string, number>,
	catalog: UnitCatalog | undefined,
): TroopsState {
	if (!state.garrisons.some((g) => g.settlement === settlement)) return state;
	return {
		...state,
		garrisons: state.garrisons.map((g) => (g.settlement === settlement ? movedUnits(g, moved, (u) => catalog?.[u]) : g)),
	};
}

/** The garrison (`troops.garrison`) with `moved` gone, when it is `settlement`'s. */
export const garrisonMoved = (
	g: GarrisonInfo | null,
	settlement: string,
	moved: Record<string, number>,
	catalog: UnitCatalog | undefined,
) => (g && g.settlement === settlement ? movedUnits(g, moved, (u) => catalog?.[u]) : g);

/** Each garrison of `troops.state`, by settlement: its units with their counts (those with none left out). */
export const heldGarrisons = (state: TroopsState) =>
	new Map(state.garrisons.map((g) => [g.settlement, Object.fromEntries(g.units.filter((u) => u.count > 0).map((u) => [u.id, u.count]))]));

/**
 * Whether `units` can leave `from` as the send forms allow them (each box "at most" what its garrison holds, some sent):
 * the forms and the assistant, which sends only what the player could (user 2026-11-24: "小助手只是'秘书'").
 */
export function unitsFit(state: TroopsState, from: string, units: Record<string, number>): boolean {
	const here = heldGarrisons(state).get(from) ?? {};
	const sent = Object.entries(units).filter(([, n]) => n > 0);
	return sent.length > 0 && sent.every(([u, n]) => Number.isInteger(n) && n <= (here[u] ?? 0));
}

/**
 * A training batch's seconds, the same on both ends (the queue starts it for this long): each unit's base seconds
 * (static `troops.units`) times the settlement's time factor (its parts in the train form), over the global speed
 * (static `troops.speed`), times the count; a whole second at least.
 */
export const batchSeconds = (base: number, factor: number, speed: number, count: number) =>
	Math.max(1, Math.ceil(((base * factor) / speed) * count));
