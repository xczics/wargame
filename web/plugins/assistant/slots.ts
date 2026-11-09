// A settlement's slots as the City page has them (web/plugins/buildings/slots.ts): what stands in each, the level it
// reaches once what is being built is done, and what an empty one may hold. Pure: the building panel and the scans
// (an institute put in the queue for research) go by it.
import type { BuildingsState } from '../../../src/shared/api';
import { type BuildingCatalog, slotsOf } from '../../../src/shared/buildings';
import type { CardsData } from '../../../src/shared/ui';

export interface Slot {
	key: string;
	district: string;
	slot: number;
	districtType: string;
	districtIdx: number;
	/** What stands there (or is being built there from nothing, at level 0). */
	current: { building: string; level: number; cap: number } | null;
	/** What is being built there, to which level. */
	building: { building: string; targetLevel: number } | null;
	/** The level it has once what is being built there is done. */
	reaches: number;
	/** For an empty slot: what it may hold. */
	options: string[];
}

export function slotList(st: BuildingsState, cards: CardsData | undefined): Slot[] {
	const plans = (cards?.data as BuildingCatalog | undefined)?.buildings ?? {};
	const { slots, taken } = slotsOf(st, plans);
	return slots.map(({ district: d, slot, placed: p, building: c }): Slot => {
		const current = p
			? { building: p.building, level: p.level, cap: p.cap }
			: c
				? { building: c.building, level: 0, cap: plans[c.building]?.cap ?? 1 }
				: null;
		const options = current
			? []
			: (cards?.choiceSets?.[`${st.settlement.kind}|${d.type}`] ?? []).map((ch) => ch.id ?? '').filter((id) => id && !taken(id, d.id));
		return {
			key: `${d.id}|${slot}`,
			district: d.id,
			slot,
			districtType: d.type,
			districtIdx: d.idx,
			current,
			building: c ? { building: c.building, targetLevel: c.targetLevel } : null,
			reaches: Math.max(current?.level ?? 0, c?.targetLevel ?? 0),
			options,
		};
	});
}
