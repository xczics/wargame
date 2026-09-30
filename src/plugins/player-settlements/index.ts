/**
 * Default content: the four kinds of player settlement.
 *
 *   capital            inner city (non-resource buildings) + outer cities (resource buildings); one per player
 *   city               same layout, limited number per player
 *   fortress-resource  one tile: storage + resource buildings; no troops
 *   fortress-military  one tile: storage only; can garrison troops
 *
 * Slot counts, limits and founding costs are GM-tunable. NPC kinds (troop fortresses,
 * food outposts, ...) belong in their own plugins, registered the same way with `npc: true`.
 */
import { definePlugin, GameError, numberInRange, numberRecord } from '../../kernel';
import type { Cost } from '../resources';

/** Categories an inner city accepts: everything except resource buildings. */
const INNER = ['civic', 'military', 'storage'];

export default definePlugin({
	id: 'player-settlements',
	version: '0.1.0',
	description: 'Capital, city, resource fortress and military fortress',
	dependsOn: ['settlements', 'resources'],
	setup(ctx) {
		const settlements = ctx.services.get('settlements');
		const resources = ctx.services.get('resources');
		const cost = numberRecord(() => resources.list().map((r) => r.id), 0, 1e12);

		const innerSlots = ctx.config.define('innerSlots', {
			description: 'Building slots of an inner city (capital and cities).',
			default: () => 12,
			parse: numberInRange(1, 100),
		});
		const outerSlots = ctx.config.define<[number, number]>('outerSlots', {
			description: 'Random range of building slots of a new outer city, e.g. [3, 6].',
			default: () => [3, 6],
			parse(raw) {
				if (!Array.isArray(raw) || raw.length !== 2) throw new GameError('bad_config', 'Expected [min, max]');
				const [min, max] = raw.map((v) => numberInRange(1, 100)(v));
				if (min > max) throw new GameError('bad_config', 'min must not exceed max');
				return [Math.floor(min), Math.floor(max)];
			},
		});
		const fortressSlots = ctx.config.define('fortressSlots', {
			description: 'Building slots of fortresses: { "fortress-resource": 6, "fortress-military": 3 }.',
			default: () => ({ 'fortress-resource': 6, 'fortress-military': 3 }),
			parse: (raw) => ({
				'fortress-resource': 6,
				'fortress-military': 3,
				...numberRecord(() => ['fortress-resource', 'fortress-military'], 1, 100)(raw),
			}),
		});
		const limits = ctx.config.define('limits', {
			description: 'Settlements per player before bonuses: { "city": 2, "fortress-resource": 3, "fortress-military": 3 }.',
			default: () => ({ city: 2, 'fortress-resource': 3, 'fortress-military': 3 }),
			parse: (raw) => ({
				city: 2,
				'fortress-resource': 3,
				'fortress-military': 3,
				...numberRecord(() => ['city', 'fortress-resource', 'fortress-military'], 0, 1000)(raw),
			}),
		});
		const defaultFoundCosts = (): Record<string, Cost> => ({
			city: { food: 2000, wood: 2000, stone: 2000, gold: 500 },
			'fortress-resource': { food: 800, wood: 800, stone: 800 },
			'fortress-military': { food: 1000, wood: 600, stone: 1200 },
		});
		const foundCosts = ctx.config.define<Record<string, Cost>>('foundCosts', {
			description: 'Resources paid by the founding settlement, per kind. Omitted kinds keep the default.',
			default: defaultFoundCosts,
			parse(raw) {
				const r = (raw ?? {}) as Record<string, unknown>;
				const out = defaultFoundCosts();
				for (const k of Object.keys(r)) {
					if (!(k in out)) throw new GameError('bad_config', `Unknown settlement kind "${k}"`);
					out[k] = cost(r[k]);
				}
				return out;
			},
		});

		// Every capital/city produces a little of everything, so a player who spends all of a
		// resource can never get stuck (e.g. no wood left to build the first lumber mill).
		const baseProduction = ctx.config.define<Record<string, Record<string, number>>>('baseProduction', {
			description: 'Built-in production per second by settlement kind (replaces the whole table), e.g. { "capital": { "food": 1 } }.',
			default: () => ({
				capital: { food: 1, wood: 1, stone: 1, gold: 0.2 },
				city: { food: 0.5, wood: 0.5, stone: 0.5, gold: 0.1 },
				// Raided NPC outposts slowly refill their food.
				'npc-outpost': { food: 0.5 },
			}),
			parse: (raw) => {
				if (typeof raw !== 'object' || raw === null) throw new GameError('bad_config', 'Expected { kind: { resource: perSecond } }');
				return Object.fromEntries(Object.entries(raw).map(([kind, rates]) => [kind, cost(rates)]));
			},
		});
		resources.addProducer(async (api, holder) => {
			if (!holder.startsWith('settlement:')) return {};
			const s = await settlements.get(api, holder.slice('settlement:'.length));
			return (s && baseProduction.get(api)[s.kind]) ?? {};
		});

		const inner = { type: 'inner', accepts: [...INNER], slots: (api: Parameters<typeof innerSlots.get>[0]) => innerSlots.get(api) };
		const outer = {
			type: 'outer',
			accepts: ['resource'],
			slots: (api: Parameters<typeof outerSlots.get>[0]) => outerSlots.get(api),
			initial: 1,
		};

		settlements.defineKind({ id: 'capital', name: 'Capital', garrison: true, layout: 'ring', centre: inner, outer, limit: () => 1 });
		settlements.defineKind({
			id: 'city',
			name: 'City',
			garrison: true,
			layout: 'ring',
			centre: { ...inner, accepts: [...INNER] },
			outer: { ...outer, accepts: ['resource'] },
			limit: (api) => limits.get(api).city,
			foundCost: (api) => foundCosts.get(api).city,
		});
		settlements.defineKind({
			id: 'fortress-resource',
			name: 'Resource fortress',
			garrison: false,
			layout: 'single',
			centre: { type: 'core', accepts: ['storage', 'resource'], slots: (api) => fortressSlots.get(api)['fortress-resource'] },
			limit: (api) => limits.get(api)['fortress-resource'],
			foundCost: (api) => foundCosts.get(api)['fortress-resource'],
		});
		settlements.defineKind({
			id: 'fortress-military',
			name: 'Military fortress',
			garrison: true,
			layout: 'single',
			centre: { type: 'core', accepts: ['storage'], slots: (api) => fortressSlots.get(api)['fortress-military'] },
			limit: (api) => limits.get(api)['fortress-military'],
			foundCost: (api) => foundCosts.get(api)['fortress-military'],
		});
	},
});
