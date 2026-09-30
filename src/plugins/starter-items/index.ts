/**
 * Default items, each using an extension point the core systems left for items:
 *   expansion-permit    an outer city past the research limit (up to the hard limit, ring 2)
 *   breakthrough-stone  raise one building's level cap by 1-3 (random)
 *   land-grant          one more building slot in an outer city
 */
import { definePlugin, GameError } from '../../kernel';
import type { Tile } from '../world-map';

const str = (raw: unknown, name: string) => {
	if (typeof raw !== 'string' || !raw) throw new GameError('bad_payload', `${name} is required`);
	return raw;
};

export default definePlugin({
	id: 'starter-items',
	version: '0.1.0',
	description: 'Expansion permit, breakthrough stone, land grant',
	dependsOn: ['items', 'settlements', 'buildings', 'world-map'],
	setup(ctx) {
		const items = ctx.services.get('items');
		const settlements = ctx.services.get('settlements');
		const buildings = ctx.services.get('buildings');
		const map = ctx.services.get('worldMap');

		items.define<{ settlement: string; tile: Tile }>({
			id: 'expansion-permit',
			name: 'Expansion permit',
			icon: '📜',
			description: 'Build one outer city beyond the research limit.',
			use: {
				parse(raw) {
					const p = (raw ?? {}) as Record<string, unknown>;
					const [x, y] = str(p.tile, 'tile').split(',').map(Number);
					if (!Number.isInteger(x) || !Number.isInteger(y)) throw new GameError('bad_payload', 'tile must be "x,y"');
					return { settlement: str(p.settlement, 'settlement'), tile: { x: map.wrap(x), y: map.wrap(y) } };
				},
				async apply(api, { settlement, tile }) {
					const s = await settlements.requireOwned(api, settlement);
					await settlements.addOuter(api, s.id, tile, { ignoreTechLimit: true });
				},
				form: {
					title: 'Use an expansion permit',
					fields: [
						{ name: 'settlement', label: 'settlement', type: 'hidden' },
						{ name: 'tile', label: 'Where', type: 'select', required: true },
					],
					submitLabel: 'Build outer city',
					async prepare(api, params) {
						const s = await settlements.resolve(api, params);
						if (!s || settlements.kind(s.kind).layout !== 'ring') return false;
						const candidates = await settlements.outerCandidates(api, s);
						if (!candidates.length) return false;
						return {
							defaults: { settlement: s.id },
							options: { tile: candidates.map((t) => ({ value: `${t.x},${t.y}`, label: `(${t.x}, ${t.y})` })) },
						};
					},
				},
			},
		});

		items.define<{ settlement: string; district: string; slot: number }>({
			id: 'breakthrough-stone',
			name: 'Breakthrough stone',
			icon: '💎',
			description: "Raise one building's level cap by 1-3 (random).",
			use: {
				parse(raw) {
					const p = (raw ?? {}) as Record<string, unknown>;
					const [district, slot] = str(p.target, 'target').split(':');
					return { settlement: str(p.settlement, 'settlement'), district, slot: Number(slot) };
				},
				async apply(api, { settlement, district, slot }) {
					const s = await settlements.requireOwned(api, settlement);
					const by = 1 + (crypto.getRandomValues(new Uint32Array(1))[0] % 3);
					await buildings.raiseCap(api, s.id, district, slot, by);
				},
				form: {
					title: 'Use a breakthrough stone',
					fields: [
						{ name: 'settlement', label: 'settlement', type: 'hidden' },
						{ name: 'target', label: 'Building', type: 'select', required: true },
					],
					submitLabel: 'Break through',
					async prepare(api, params) {
						const s = await settlements.resolve(api, params);
						if (!s) return false;
						const placed = await buildings.placed(api, s.id);
						const options = s.districts.flatMap((d) =>
							[...(placed.get(d.id) ?? new Map()).entries()].map(([slot, p]) => ({
								value: `${d.id}:${slot}`,
								label: `${buildings.get(p.building).name} Lv ${p.level}/${buildings.capOf(api, p)} (${d.type === 'outer' ? `outer ${d.idx}` : d.type})`,
							})),
						);
						return options.length ? { defaults: { settlement: s.id }, options: { target: options } } : false;
					},
				},
			},
		});

		items.define<{ settlement: string; district: string }>({
			id: 'land-grant',
			name: 'Land grant',
			icon: '🗺️',
			description: 'One more building slot in an outer city.',
			use: {
				parse(raw) {
					const p = (raw ?? {}) as Record<string, unknown>;
					return { settlement: str(p.settlement, 'settlement'), district: str(p.district, 'district') };
				},
				async apply(api, { settlement, district }) {
					const s = await settlements.requireOwned(api, settlement);
					const { district: d } = settlements.district(s, district);
					if (d.type !== 'outer') throw new GameError('bad_target', 'Land grants only work on outer cities');
					await settlements.addSlots(api, s.id, d.id, 1);
				},
				form: {
					title: 'Use a land grant',
					fields: [
						{ name: 'settlement', label: 'settlement', type: 'hidden' },
						{ name: 'district', label: 'Outer city', type: 'select', required: true },
					],
					submitLabel: 'Add slot',
					async prepare(api, params) {
						const s = await settlements.resolve(api, params);
						const outer = s?.districts.filter((d) => d.type === 'outer') ?? [];
						if (!s || !outer.length) return false;
						return {
							defaults: { settlement: s.id },
							options: { district: outer.map((d) => ({ value: d.id, label: `Outer city ${d.idx} (${d.slots} slots)` })) },
						};
					},
				},
			},
		});
	},
});
