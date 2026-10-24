// NPC camps on the world map (client layer "npc-camps", for the data of the server's map layer and side list of that id):
// a camp's tile tells what to expect, its level, roughly how many defend it and how strong its stockade and heroes are,
// and what a victory brings. What a level means is the static view `npc-camps.levels` (rules-made). The camps the rules
// place are worked out here from the static view `npc-camps.layout` with the server's own code (shared/npc-camps.ts);
// the server sends only what is stored about them (beaten, gone, what stands around: `MapSideCamps`), and for stored
// camps their level and when they were beaten (user 2026-10-22: "规则生成的甚至连列表都不用转"). Pure: the tests run it.
import type { MapSideCamps, MapWindow, MapWindowCamps, NearbyPart, NpcCampLevels } from '../../../src/shared/api';
import { amount, duration } from '../../../src/shared/format';
import { keyText, uiTexts } from '../../../src/shared/i18n';
import { layoutOf, type LayoutRules, mapGeometry, type RuleCamp, standingCamps } from '../../../src/shared/npc-camps';
import type { GridCell, GridSide, UiLine } from '../../../src/shared/ui';
import { type ClientViewGet, defineClientPart } from '../../../src/shared/client-views';
import type { MapLayer } from '../world-map/views';

// The npc-camps plugin's own words (its i18n keys).
const text = uiTexts('npc-camps');
const NO_ICON = '☠️';

type Row = NpcCampLevels[string][string];

/** What a camp of this row holds, `share` of its loot back, full again at `fullAt` (server time). */
function campLines(row: Row, level: number, share: number, fullAt: number | undefined, now: number): UiLine[] {
	return [
		{ text: text('Level {0}', { 0: level }) },
		// "Defenders: about 4,000 in all, up to tier 2, 1 leaders" / "..., leaderless".
		{
			text: row.heroes
				? text('Defenders: about {0} in all, up to tier {1}, {2} leaders', { 0: amount(row.defenders), 1: row.tier, 2: row.heroes })
				: text('Defenders: about {0} in all, up to tier {1}, leaderless', { 0: amount(row.defenders), 1: row.tier }),
		},
		{ text: text('Stockade: defence +{0} in every lane', { 0: amount(row.stockade) }), tone: 'muted' },
		row.takes === 'resources'
			? {
					text: text('Victory: up to {0} resources (as much as your survivors carry)', {
						0: amount(Math.floor((row.loot.total ?? 0) * share)),
					}),
					tone: 'info',
				}
			: {
					text: text('Victory: captures {0}', {
						0: Object.entries(row.loot)
							.filter(([, n]) => n > 0)
							.map(([tier, n]) => text('tier {0} ×{1}', { 0: tier, 1: amount(Math.floor(n * share)) })),
					}),
					tone: 'info',
				},
		...(fullAt !== undefined
			? [{ text: text('Recently beaten: full again in {0}', { 0: duration((fullAt - now) / 1000) }), tone: 'muted' as const }]
			: []),
	];
}

/** The rule camps standing within `radius` (a square) of the window's centre, as the server decides it. */
function ruleCamps(side: MapSideCamps | undefined, window: MapWindow, radius: number, get: ClientViewGet) {
	const rules = get.static<LayoutRules>('npc-camps.layout');
	const bounds = get.meta<{ min: number; max: number }>('map');
	if (!side || !rules || !bounds) return null;
	const { size, wrap } = mapGeometry(bounds.min, bounds.max);
	const taken = new Set(side.taken);
	const camps = standingCamps(layoutOf(rules, size, wrap).around(window.centre, Math.min(radius, side.area)), {
		removed: (id) => !!side.states[id]?.removed,
		taken: (key) => taken.has(key) || key in window.held,
		capitals: side.capitals,
		wrap,
	});
	return { camps, wrap };
}

/** How full a camp's loot is (refilling linearly after a victory, the rule `npc-camps.refillHours`), and when full. */
function refill(raidedAt: number | undefined, now: number, get: ClientViewGet) {
	const hours = get.static<{ hours: number }>('npc-camps.refill')?.hours ?? 0;
	if (raidedAt === undefined || hours <= 0) return { share: 1 };
	const share = Math.min(1, Math.max(0, (now - raidedAt) / (hours * 3600_000)));
	return share < 1 ? { share, fullAt: raidedAt + hours * 3600_000 } : { share };
}

const layer: MapLayer<MapWindowCamps, MapSideCamps> = {
	order: 20,
	cells(data, window, get) {
		const levels = get.static<NpcCampLevels>('npc-camps.levels');
		const out = new Map<string, Partial<GridCell>>();
		if (!levels) return out;
		// Stored camps: the settlements layer draws them; their level and loot here.
		for (const [key, entity] of Object.entries(window.held)) {
			if (!entity.startsWith('settlement:')) continue;
			const camp = data[entity.slice('settlement:'.length)];
			const row = camp && levels[camp.kind]?.[camp.level];
			if (!camp || !row) continue;
			out.set(key, { info: campLines(row, camp.level, camp.share, camp.fullAt, window.now) });
		}
		// The rules' camps: all of their tile.
		const side = window.sides['npc-camps'] as MapSideCamps | undefined;
		const kinds = new Map((get.meta('settlementKinds') ?? []).map((k) => [k.id, k]));
		for (const c of ruleCamps(side, window, window.radius, get)?.camps ?? []) {
			const row = levels[c.kind]?.[c.level];
			if (!row) continue;
			const { share, fullAt } = refill(side!.states[c.id]?.raidedAt, window.now, get);
			const kind = kinds.get(c.kind);
			// (A static view baked before rows had names: the kind's name, not a broken page.)
			const name = keyText(row.name ?? kind?.name ?? c.kind);
			out.set(`${c.x},${c.y}`, {
				icon: kind?.icon ?? NO_ICON,
				tone: 'enemy',
				title: [name],
				info: [
					{ text: text('{name} ({kind}) · NPC', { name, kind: keyText(kind?.name ?? c.kind) }) },
					...campLines(row, c.level, share, fullAt, window.now),
				],
			});
		}
		return out;
	},
	// The rules' camps around the centre, merged into the list of stored NPC settlements (web/plugins/settlement).
	side(data, window, get): GridSide | null {
		const levels = get.static<NpcCampLevels>('npc-camps.levels');
		const found = ruleCamps(data, window, data.r, get);
		if (!levels || !found) return null;
		const kinds = new Map((get.meta('settlementKinds') ?? []).map((k) => [k.id, k]));
		const distance = (c: RuleCamp) => Math.hypot(found.wrap(c.x - window.centre.x), found.wrap(c.y - window.centre.y));
		return {
			title: text('NPC settlements nearby'),
			merge: 'npc-nearby',
			items: found.camps
				.map((c) => ({ c, exact: distance(c) }))
				.filter(({ exact }) => exact <= data.r)
				.map(({ c, exact }) => ({ c, d: Math.round(exact * 10) / 10 }))
				.map(({ c, d }) => {
					const kind = kinds.get(c.kind);
					return {
						label: text('{0} {1} ({2})', {
							0: kind?.icon ?? NO_ICON,
							1: keyText(levels[c.kind]?.[c.level]?.name ?? kind?.name ?? c.kind),
							2: keyText(kind?.name ?? c.kind),
						}),
						sub: [text('({0}, {1})', { 0: c.x, 1: c.y }), text('{n} tiles', { n: d })],
						at: { x: c.x, y: c.y },
						rank: d,
					};
				}),
		};
	},
};

// At the world map's extension point, for the data of the server plugin "npc-camps".
export const mapPart = defineClientPart<MapLayer>({ point: 'world-map.layer', id: 'npc-camps', part: layer as MapLayer });

// The nearby list's share (settlements.nearby, the assistant's targets): the rules' camps within its radius, and the
// level of the stored ones and when they are full again.
const nearby = (window: MapWindow, get: ClientViewGet): NearbyPart | null => {
	const side = window.sides['npc-camps'] as MapSideCamps | undefined;
	const levels = get.static<NpcCampLevels>('npc-camps.levels');
	const found = ruleCamps(side, window, side?.r ?? 0, get);
	if (!side || !levels || !found) return null;
	const info: NearbyPart['info'] = {};
	for (const [id, c] of Object.entries(side.stored)) {
		const { fullAt } = refill(c.raidedAt, window.now, get);
		info[id] = { level: c.level, ...(fullAt !== undefined ? { fullAt } : {}) };
	}
	const add: NearbyPart['add'] = [];
	for (const c of found.camps) {
		const d = Math.hypot(found.wrap(c.x - window.centre.x), found.wrap(c.y - window.centre.y));
		if (d > side.r) continue;
		const { fullAt } = refill(side.states[c.id]?.raidedAt, window.now, get);
		add.push({
			settlement: c.id,
			kind: c.kind,
			name: keyText(levels[c.kind]?.[c.level]?.name ?? c.kind),
			x: c.x,
			y: c.y,
			npc: true,
			ownerName: null,
			distance: Math.round(d * 10) / 10,
			level: c.level,
			...(fullAt !== undefined ? { fullAt } : {}),
		});
	}
	return { add, info };
};
export const nearbyPart = defineClientPart({ point: 'settlements.nearby', id: 'npc-camps', part: nearby });
