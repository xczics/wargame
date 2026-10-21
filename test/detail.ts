/**
 * A settlement's districts slot by slot, for the city tests: what stands in each slot, what is being built and what
 * each slot may start now, with its quote, effects and why it is refused, as the buildings service works them out
 * (the commands check the same). The page itself has them from `settlements.outline`, `buildings.state` and the
 * static `buildings.catalog`; this puts the server's answers next to each other.
 */
import type { EngineContext, Kernel } from '../src/kernel';
import { levelEffects, type BuildingCatalog } from '../src/shared/buildings';
import type { BuildingEffects, BuildingsState, DistrictInfo, SettlementOutline } from '../src/shared/api';
import type { CardsData, UiText } from '../src/shared/ui';
import { probe, staticIn, viewIn } from './probe';

export interface BuildOption {
	building: string;
	level: number;
	cost: Record<string, number>;
	seconds: number;
	effects: BuildingEffects;
	affordable: boolean;
	blocked?: UiText;
}
export interface SlotInfo {
	slot: number;
	current: { building: string; level: number; effects: BuildingEffects; cap: number } | null;
	construction: { building: string; targetLevel: number; startedAt: number; finishesAt: number } | null;
	/** Empty slot: every building allowed here. Built slot: the next level. */
	options: BuildOption[];
}
export interface SettlementDetail extends Omit<SettlementOutline, 'districts' | 'limits'> {
	districts: (DistrictInfo & { slots: SlotInfo[] })[];
	limits: SettlementOutline['limits'] & { queue: number; queueUsed: number };
}

export function detailOf(kernel: Kernel, ctx: EngineContext, settlement?: string): Promise<SettlementDetail> {
	const params: Record<string, string> = settlement ? { settlement } : {};
	return probe(
		kernel,
		ctx,
		async (api, k) => {
			const outline = await viewIn<SettlementOutline | null>(k, api, 'settlements.outline', params);
			const state = await viewIn<BuildingsState | null>(k, api, 'buildings.state', params);
			if (!outline || !state) return null as never;
			const settlements = k.services.get('settlements');
			const buildings = k.services.get('buildings');
			const resources = k.services.get('resources');
			const s = (await settlements.resolve(api, params))!;
			const catalog = (await staticIn<CardsData>(k, api, 'buildings.catalog')).data as BuildingCatalog;
			const effects = (building: string, level: number, own?: Record<string, Record<string, number>>): BuildingEffects => ({
				...levelEffects(catalog.buildings[building], level, catalog.productionMultiplier),
				...(own && Object.keys(own).length ? { own } : {}),
			});
			const { used, size } = state.queue;
			const option = async (districtId: string, slot: number, building: string, fromLevel: number, busy: UiText | null) => {
				const req = { settlement: s, districtId, slot, building: buildings.get(building), fromLevel, toLevel: fromLevel + 1 };
				const { cost, seconds } = await buildings.quote(api, req);
				const blocked = busy ?? (await buildings.check(api, req)) ?? undefined;
				const own = state.effects[`${districtId}/${slot}`]?.next;
				return {
					building,
					level: req.toLevel,
					cost,
					seconds,
					effects: effects(building, req.toLevel, fromLevel ? own : undefined),
					affordable: await resources.canAfford(api, settlements.entity(s.id), cost),
					...(blocked ? { blocked } : {}),
				} satisfies BuildOption;
			};
			const districts: SettlementDetail['districts'] = [];
			for (const d of outline.districts) {
				const { template } = settlements.district(s, d.id);
				const slots: SlotInfo[] = [];
				for (let slot = 0; slot < d.size; slot++) {
					const current = state.slots.find((x) => x.district === d.id && x.slot === slot) ?? null;
					const c = state.construction.find((x) => x.district === d.id && x.slot === slot) ?? null;
					const busy: UiText | null = c
						? { text: 'buildings.Under construction' }
						: used >= size
							? { text: 'buildings.Construction queue full ({0}/{1})', vars: { 0: used, 1: size } }
							: null;
					let options: BuildOption[] = [];
					if (current) options = [await option(d.id, slot, current.building, current.level, busy)];
					else if (!c)
						for (const b of buildings.list())
							if (template.accepts.includes(b.category) && (!b.kinds || b.kinds.includes(s.kind)))
								options.push(await option(d.id, slot, b.id, 0, busy));
					slots.push({
						slot,
						current: current
							? {
									building: current.building,
									level: current.level,
									effects: effects(current.building, current.level, state.effects[`${d.id}/${slot}`]?.now),
									cap: current.cap,
								}
							: null,
						construction: c ? { building: c.building, targetLevel: c.targetLevel, startedAt: c.startedAt, finishesAt: c.finishesAt } : null,
						options,
					});
				}
				districts.push({ ...d, slots });
			}
			return { ...outline, districts, limits: { ...outline.limits, queue: size, queueUsed: used } };
		},
		params,
	);
}
