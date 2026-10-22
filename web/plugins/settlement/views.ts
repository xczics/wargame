// The settlements plugin's views assembled in the browser (src/shared/client-views.ts).
import type { MapSideNearby, MapWindow, NearbyOverview, NearbyPart, SettlementOutline } from '../../../src/shared/api';
import { type ClientViewGet, defineClientView } from '../../../src/shared/client-views';
import { districtBoard } from './districts';

/** Extension point "settlements.nearby": what other plugins add to the list (`NearbyPart`), e.g. the camps rules place. */
export const NEARBY_PART = 'settlements.nearby';

export const views = [
	// The NPC settlements around a point, from the map's data (the stored ones beside the window, `nearbyR` tiles) and
	// what other plugins add: worked out here, nothing more asked of the server (user 2026-10-22: "小助手只能用前端数据").
	defineClientView<NearbyOverview>({
		id: 'settlements.nearby',
		needs: ['world-map.window'],
		compute(get) {
			const w = get.data<MapWindow>('world-map.window');
			const side = w?.sides.settlements as MapSideNearby | undefined;
			if (!w || !side) return { maxRadius: 0, settlements: [] };
			const parts = [...get.parts<(window: MapWindow, get: ClientViewGet) => NearbyPart | null>(NEARBY_PART).values()].map((p) =>
				p(w, get),
			);
			const info = Object.assign({}, ...parts.map((p) => p?.info ?? {})) as NearbyPart['info'];
			const settlements = [
				...side.items.map((s) => ({ ...s, npc: true, ownerName: null, ...info[s.settlement] })),
				...parts.flatMap((p) => p?.add ?? []),
			]
				.sort((a, b) => a.distance - b.distance)
				.slice(0, side.limit);
			return { maxRadius: Math.max(side.r, ...side.radii), settlements };
		},
	}),
	defineClientView({
		id: 'settlements.districts',
		needs: ['settlements.outline'],
		compute: (get) =>
			districtBoard(get.data<SettlementOutline | null>('settlements.outline'), get.meta('resources') ?? [], get.meta('map')),
	}),
];
