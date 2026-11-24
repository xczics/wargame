// What the troops' commands did, applied to the player's data held in the browser (`game.patchView`; user 2026-11-20:
// "你告诉前端成功了，前端不就能更新了吗？"): a page other than the one the command came from shows it at once. Pure: the
// tests run them.
import type { GarrisonInfo, TroopsState } from '../../../src/shared/api';

/** A plan cancelled: gone from the garrison's training. */
export const withoutPlan = (g: GarrisonInfo | null, id: string) =>
	g && g.training.some((b) => b.id === id) ? { ...g, training: g.training.filter((b) => b.id !== id) } : g;

/** A training order as the answer tells it (`troops.queued`): its id, and when it ends if it started (null: it waits). */
export interface Queued {
	id: string;
	finishesAt: number | null;
}

/**
 * A batch ordered at `now` (`troops.train`), into the garrison's training: paid per unit as the static numbers say
 * (`troops.units`), in the line of the building that trains it, started at once when the answer gives its end.
 */
export function garrisonTrained(
	g: GarrisonInfo | null,
	p: { settlement: string; unit: string; count: number },
	q: Queued,
	at: { now: number; line: string; cost: Record<string, number> },
): GarrisonInfo | null {
	if (!g || g.settlement !== p.settlement || g.training.some((b) => b.id === q.id)) return g;
	const cost = Object.fromEntries(Object.entries(at.cost).map(([r, n]) => [r, n * p.count]));
	const batch = {
		id: q.id,
		line: at.line,
		unit: p.unit,
		count: p.count,
		cost,
		startedAt: q.finishesAt === null ? null : at.now,
		finishesAt: q.finishesAt,
	};
	return { ...g, training: [...g.training, batch] };
}

/** The same batch in `troops.state` (the Army page: unit, count, end). */
export function stateTrained(state: TroopsState, p: { settlement: string; unit: string; count: number }, q: Queued): TroopsState {
	if (!state.garrisons.some((x) => x.settlement === p.settlement)) return state;
	return {
		...state,
		garrisons: state.garrisons.map((x) =>
			x.settlement === p.settlement ? { ...x, training: [...x.training, { unit: p.unit, count: p.count, finishesAt: q.finishesAt }] } : x,
		),
	};
}

/**
 * A waiting plan cancelled, in `troops.state` (no ids there: both views list a settlement's training in the same
 * order, so the plan's place in the garrison's says which).
 */
export function stateCancelled(state: TroopsState, settlement: string, index: number): TroopsState {
	return {
		...state,
		garrisons: state.garrisons.map((x) => (x.settlement === settlement ? { ...x, training: x.training.filter((_, k) => k !== index) } : x)),
	};
}
