// Staged marches (src/shared/api.ts `StagedMarch`): short marches to own settlements the server settled when they were
// sent. The browser plays them out: shown travelling on the Army page, and what they moved kept out of the garrisons and
// stocks it shows until it would have arrived (user 2026-10-21: "前端还是'装装样子'"; "小助手看到的，就是玩家看到的").
// Pure: the tests run them.
import type { ArmyMarch, GarrisonInfo, ResourcePool, StagedEffect, StagedMarch, TroopsState } from '../../../src/shared/api';

/** What of the staged marches has not reached `settlement` by `now`: units and resources the server already counts there. */
export function notArrived(staged: readonly StagedMarch[], settlement: string, now: number) {
	const units: Record<string, number> = {};
	const resources: Record<string, number> = {};
	let any = false;
	for (const m of staged)
		for (const e of m.effects as StagedEffect[]) {
			if (e.settlement !== settlement || e.at <= now) continue;
			any = true;
			for (const [u, n] of Object.entries(e.units)) units[u] = (units[u] ?? 0) + n;
			for (const [r, n] of Object.entries(e.resources)) resources[r] = (resources[r] ?? 0) + n;
		}
	return any ? { units, resources } : null;
}

/** Still to be played out at `now` (until home again, or until there for a trip that ends there). */
export const playing = (staged: readonly StagedMarch[], now: number) => staged.filter((m) => m.returnsAt > now);

export function stagedPool(pool: ResourcePool, staged: readonly StagedMarch[], now: number): ResourcePool {
	const away = notArrived(staged, pool.holder.replace(/^settlement:/, ''), now);
	if (!away) return pool;
	const amounts = { ...pool.amounts };
	for (const [r, n] of Object.entries(away.resources)) amounts[r] = (amounts[r] ?? 0) - n;
	return { ...pool, amounts };
}

const withoutUnits = <U extends { id: string; count: number }>(units: U[], away: Record<string, number>) =>
	units.map((u) => (away[u.id] ? { ...u, count: Math.max(0, u.count - away[u.id]) } : u)).filter((u) => u.count > 0);

/** A garrison (`troops.garrison`, or one of `troops.state`'s) without what has not arrived. */
export function stagedGarrison<G extends Pick<GarrisonInfo, 'settlement'> & { units: { id: string; count: number }[] }>(
	g: G,
	staged: readonly StagedMarch[],
	now: number,
): G {
	const away = notArrived(staged, g.settlement, now);
	return away ? { ...g, units: withoutUnits(g.units, away.units) } : g;
}

export function stagedTroops(state: TroopsState, staged: readonly StagedMarch[], now: number): TroopsState {
	if (!playing(staged, now).length) return state;
	return { ...state, garrisons: state.garrisons.map((g) => stagedGarrison(g, staged, now)) };
}

/** The marches with the staged ones still under way, each in its phase at `now`. */
export function stagedList(list: ArmyMarch[], staged: readonly StagedMarch[], now: number): ArmyMarch[] {
	const shown = playing(staged, now).filter((m) => !list.some((a) => a.id === m.id));
	if (!shown.length) return list;
	const marches = shown.map(({ effects: _effects, ...m }): ArmyMarch => ({ ...m, phase: now < m.arrivesAt ? 'outbound' : 'returning' }));
	return [...list, ...marches].sort((a, b) => a.departedAt - b.departedAt);
}
