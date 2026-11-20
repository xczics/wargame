/**
 * Heroes put on a duty (or freed) by a command the browser sent (an army led out, a trade-route team departing or
 * recalled), applied to the heroes' data it holds (`heroes.list`, `heroes.state`, `realms.overview`), so every page
 * shows it at once (user 2026-11-20: "你告诉前端成功了，前端不就能更新了吗？"). The shapes are the views' own
 * (src/shared/api.ts). Pure.
 */
import type { HeroesState, RealmsOverview, ViewMap } from './api';
import type { UiText } from './ui';

export interface DutyChange {
	duty: string;
	/** What the server stores as its target (a settlement, an army...). */
	target: string | null;
	/** What `heroes.state` shows for it: the name of the player's settlement it serves, else null. */
	targetName?: UiText | null;
}

export const listOnDuty = (list: ViewMap['heroes.list'], ids: ReadonlySet<string>, c: DutyChange): ViewMap['heroes.list'] =>
	list.some((h) => ids.has(h.id)) ? list.map((h) => (ids.has(h.id) ? { ...h, duty: c.duty, dutyTarget: c.target } : h)) : list;

export const stateOnDuty = (s: HeroesState | null, ids: ReadonlySet<string>, c: DutyChange): HeroesState | null =>
	s && s.heroes.some((h) => ids.has(h.id))
		? { ...s, heroes: s.heroes.map((h) => (ids.has(h.id) ? { ...h, duty: c.duty, target: c.targetName ?? null } : h)) }
		: s;

export const overviewOnDuty = (o: RealmsOverview, ids: ReadonlySet<string>, c: DutyChange): RealmsOverview =>
	o.heroes.some((h) => ids.has(h.id)) ? { ...o, heroes: o.heroes.map((h) => (ids.has(h.id) ? { ...h, idle: c.duty === 'idle' } : h)) } : o;

/** All three, through the browser's `game.patchView`. */
export function heroesOnDuty(patch: <T>(view: string, change: (value: T) => T) => void, ids: Iterable<string>, c: DutyChange) {
	const set = new Set(ids);
	if (!set.size) return;
	patch<ViewMap['heroes.list']>('heroes.list', (l) => listOnDuty(l, set, c));
	patch<HeroesState | null>('heroes.state', (s) => stateOnDuty(s, set, c));
	patch<RealmsOverview>('realms.overview', (o) => overviewOnDuty(o, set, c));
}
