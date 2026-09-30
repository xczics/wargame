/**
 * Default items (names and numbers in ./data), each using an extension point the core systems left for items:
 *   expansion-permit    an outer city past the research limit (up to the hard limit, ring 2)
 *   breakthrough-stone  raise one building's level cap by 1-3 (random)
 *   land-grant          one more building slot in an outer city
 */
import { csvRows, csvRules, definePlugin, GameError, numberFields, PluginError } from '../../kernel';
import type { Tile } from '../world-map';
import itemsCsv from './data/items.csv?raw';
import rulesCsv from './data/rules.csv?raw';

/** Names, icons and descriptions by item id (./data/items.csv). */
const INFO = new Map(
	csvRows(itemsCsv).map((r) => [r.id, { name: r.name, icon: r.icon || undefined, description: r.description || undefined }]),
);
const RULES = csvRules(rulesCsv);
const info = (id: string) => {
	const i = INFO.get(id);
	if (!i) throw new PluginError(`starter-items: "${id}" is missing from data/items.csv`);
	return { id, ...i };
};

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
		const breakthrough = ctx.config.define('breakthrough', {
			description: 'A breakthrough stone raises a level cap by a random whole number of levels in [min, max].',
			default: () => RULES.breakthrough as { min: number; max: number },
			parse: (raw) => {
				const v = numberFields(() => RULES.breakthrough as { min: number; max: number }, 1, 1000)(raw);
				if (v.max < v.min) throw new GameError('bad_config', 'max must be at least min');
				return { min: Math.floor(v.min), max: Math.floor(v.max) };
			},
		});

		items.define<{ settlement: string; tile: Tile }>({
			...info('expansion-permit'),
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
							options: {
								tile: await Promise.all(
									candidates.map(async (t) => ({ value: `${t.x},${t.y}`, label: await settlements.tileLabel(api, t) })),
								),
							},
						};
					},
				},
			},
		});

		items.define<{ settlement: string; district: string; slot: number }>({
			...info('breakthrough-stone'),
			use: {
				parse(raw) {
					const p = (raw ?? {}) as Record<string, unknown>;
					const [district, slot] = str(p.target, 'target').split(':');
					return { settlement: str(p.settlement, 'settlement'), district, slot: Number(slot) };
				},
				async apply(api, { settlement, district, slot }) {
					const s = await settlements.requireOwned(api, settlement);
					const { min, max } = breakthrough.get(api);
					const by = min + (crypto.getRandomValues(new Uint32Array(1))[0] % (max - min + 1));
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
			...info('land-grant'),
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
