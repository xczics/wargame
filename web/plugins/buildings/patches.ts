// What the building commands did, applied to a settlement's buildings held in the browser (`game.patchView`; user
// 2026-11-24: "命令之后，根据服务端返回内容直接更新前端大对象"): the construction ordered, cancelled or a level torn down,
// with its times worked out as the server does (src/shared/buildings.ts, the static `buildings.catalog`, the state's own
// time factor) from the clock the command ran at. Pure: the tests run them against the server's re-read.
import type { BuildingsState } from '../../../src/shared/api';
import { type BuildingCatalog, demolishQuote, levelCost } from '../../../src/shared/buildings';

export interface SlotOrder {
	settlement: string;
	district: string;
	slot: number;
	building?: string;
}

const busy = (s: BuildingsState, p: SlotOrder) => s.construction.some((c) => c.district === p.district && c.slot === p.slot);

/**
 * A construction ordered at `now` (`buildings.construct`): the next level of what stands there (or level 1 of
 * `building`), for that level's time under the rules (`levelCost`) times the settlement's time factor, as the server's
 * `quote`. Unchanged: not this settlement, or not something it could order.
 */
export function constructed(s: BuildingsState, p: SlotOrder, catalog: BuildingCatalog, now: number): BuildingsState {
	if (s.settlement.id !== p.settlement || busy(s, p)) return s;
	const placed = s.slots.find((x) => x.district === p.district && x.slot === p.slot);
	const building = placed?.building ?? p.building;
	const plan = building ? catalog.buildings[building] : undefined;
	if (!building || !plan) return s;
	const targetLevel = (placed?.level ?? 0) + 1;
	const seconds = Math.max(1, Math.ceil(levelCost(plan, targetLevel, catalog).seconds * Math.max(0, s.time.factor)));
	return {
		...s,
		construction: [
			...s.construction,
			{ district: p.district, slot: p.slot, building, targetLevel, startedAt: now, finishesAt: now + seconds * 1000 },
		],
		queue: { ...s.queue, used: s.queue.used + 1 },
	};
}

/** A construction (or demolition) cancelled: its place in the queue is free again (the refund is in the pool). */
export function cancelled(s: BuildingsState, p: SlotOrder): BuildingsState {
	if (s.settlement.id !== p.settlement || !busy(s, p)) return s;
	return {
		...s,
		construction: s.construction.filter((c) => !(c.district === p.district && c.slot === p.slot)),
		queue: { ...s.queue, used: s.queue.used - 1 },
	};
}

/** A level torn down from `now` (`buildings.demolish`): a share of that level's time, no bonuses (`demolishQuote`). */
export function demolished(s: BuildingsState, p: SlotOrder, catalog: BuildingCatalog, now: number): BuildingsState {
	if (s.settlement.id !== p.settlement || busy(s, p) || !catalog.demolish) return s;
	const placed = s.slots.find((x) => x.district === p.district && x.slot === p.slot);
	const plan = placed && catalog.buildings[placed.building];
	if (!placed || !plan || placed.level < 1) return s;
	const { seconds } = demolishQuote(plan, placed.level, { ...catalog, demolish: catalog.demolish });
	return {
		...s,
		construction: [
			...s.construction,
			{
				district: p.district,
				slot: p.slot,
				building: placed.building,
				targetLevel: placed.level - 1,
				startedAt: now,
				finishesAt: now + seconds * 1000,
				demolish: true,
			},
		],
		queue: { ...s.queue, used: s.queue.used + 1 },
	};
}
