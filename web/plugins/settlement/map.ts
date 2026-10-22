// The settlements on the world map (client layer "settlements", for the data of the server's map layer and side list of
// that id): icon at the centre, border by owner, what it is when selected and a way to open one's own; beside the map,
// the NPC settlements around its centre. Kinds' names and icons come from meta `settlementKinds`. Pure: the tests run it.
import type { MapSideNearby, MapWindowSettlements } from '../../../src/shared/api';
import { keyText, literal, uiTexts } from '../../../src/shared/i18n';
import type { GridCell, UiText } from '../../../src/shared/ui';
import { defineClientPart } from '../../../src/shared/client-views';
import type { MapLayer } from '../world-map/views';

// The settlements plugin's own words (its i18n keys).
const text = uiTexts('settlements');
const NO_ICON = '☠️';

const layer: MapLayer<MapWindowSettlements, MapSideNearby> = {
	order: 10,
	cells(data, window, get) {
		const kinds = new Map((get.meta('settlementKinds') ?? []).map((k) => [k.id, k]));
		const out = new Map<string, Partial<GridCell>>();
		for (const [key, entity] of Object.entries(window.held)) {
			if (!entity.startsWith('settlement:')) continue;
			const id = entity.slice('settlement:'.length);
			const s = data[id];
			if (!s) continue;
			const [x, y] = key.split(',').map(Number);
			const kind = kinds.get(s.kind);
			out.set(key, {
				icon: x === s.x && y === s.y ? (kind?.icon ?? NO_ICON) : '·',
				tone: s.mine ? 'mine' : s.owner !== undefined ? 'occupied' : 'enemy',
				title: [s.name],
				info: [
					{
						text: text('{name} ({kind}) · {owner}', {
							name: s.name,
							kind: keyText(kind?.name ?? s.kind),
							owner: s.mine ? text('yours') : s.owner !== undefined ? literal(s.owner) : text('NPC'),
						}),
					},
				],
				...(s.mine ? { actions: [{ params: { settlement: id }, label: text('Open') }] } : {}),
			});
		}
		return out;
	},
	side(data, window, get) {
		const kinds = new Map((get.meta('settlementKinds') ?? []).map((k) => [k.id, k]));
		return {
			title: text('NPC settlements nearby'),
			// With the camps the rules place (web/plugins/npc-camps), nearest first.
			merge: 'npc-nearby',
			limit: data.limit,
			choice: {
				param: 'nearbyR',
				options: data.radii.map((v) => ({ value: String(v), label: text('{n} tiles', { n: v }) })),
				selected: String(data.r),
			},
			notes: [{ text: text('Around the centre of the map ({x}, {y}).', { x: window.centre.x, y: window.centre.y }), tone: 'muted' }],
			items: data.items.map((s) => ({
				label: text('{0} {1} ({2})', {
					0: kinds.get(s.kind)?.icon ?? NO_ICON,
					1: s.name,
					2: keyText(kinds.get(s.kind)?.name ?? s.kind),
				}),
				sub: [text('({0}, {1})', { 0: s.x, 1: s.y }) as UiText, text('{n} tiles', { n: s.distance })],
				at: { x: s.x, y: s.y },
				rank: s.distance,
			})),
			empty: text('None.'),
		};
	},
};

// At the world map's extension point, for the data of the server plugin "settlements".
export const mapPart = defineClientPart<MapLayer>({ point: 'world-map.layer', id: 'settlements', part: layer as MapLayer });
