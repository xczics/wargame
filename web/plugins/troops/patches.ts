// What the troops' commands did, applied to the player's data held in the browser (`game.patchView`; user 2026-11-20:
// "你告诉前端成功了，前端不就能更新了吗？"): a page other than the one the command came from shows it at once. Pure: the
// tests run them.
import type { GarrisonInfo, TroopsState } from '../../../src/shared/api';

/** The training of a garrison as the server has it now (`troops.garrison` in a command's answer), in `troops.state`. */
export function stateTraining(state: TroopsState, g: GarrisonInfo): TroopsState {
	if (!state.garrisons.some((x) => x.settlement === g.settlement)) return state;
	const training = g.training.map(({ unit, count, finishesAt }) => ({ unit, count, finishesAt }));
	return { ...state, garrisons: state.garrisons.map((x) => (x.settlement === g.settlement ? { ...x, training } : x)) };
}

/** A plan cancelled: gone from the garrison's training. */
export const withoutPlan = (g: GarrisonInfo | null, id: string) =>
	g && g.training.some((b) => b.id === id) ? { ...g, training: g.training.filter((b) => b.id !== id) } : g;
