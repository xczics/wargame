/** Loot: reward pools and the drop algorithm (draw by weight until a minimum total value). */
import { describe, expect, it } from 'vitest';
import { createKernel, definePlugin, engineContext, resolveConfig, seededRandom } from '../../src/kernel';
import { plugins } from '../../src/plugins';
import type { NpcCampOccasion } from '../../src/plugins/npc-camps';
import type { PvpOccasion } from '../../src/plugins/pvp';
import { wrap } from '../../src/plugins/world-map';
import type { ArmyInfo } from '../../src/shared/api';
import { T0, player } from '../helpers';

// A test pool, and something put in the camps' and players' pools (empty by default).
const testLoot = definePlugin({
	id: 'test-loot',
	version: '0',
	dependsOn: ['loot', 'npc-camps', 'pvp', 'resources'],
	setup(ctx) {
		const loot = ctx.services.get('loot');
		loot.definePool('test-loot');
		const give = (n: number) => async () => [{ kind: 'item', name: 'Thing', count: n }];
		loot.addDrop('test-loot', { id: 'pebble', weight: 9, preview: { kind: 'item', name: 'Pebble' }, give: give(1) });
		loot.addDrop('test-loot', { id: 'pearl', weight: 1, preview: { kind: 'item', name: 'Pearl' }, give: give(1) });
		loot.addDrop('test-loot', { id: 'nugget', weight: 5, value: 2, give: give(1) });
		const gold = (playerId: string) => ({ kind: 'resource', name: 'Gold', count: 1, playerId });
		loot.addDrop<NpcCampOccasion>('npc-camps', { id: 'camp-trinket', weight: 1, give: async (_api, c) => [gold(c.playerId)] });
		loot.addDrop<PvpOccasion>('pvp', { id: 'war-trophy', weight: 1, give: async (_api, c) => [gold(c.attackerId)] });
	},
});
const kernel = createKernel([...plugins, testLoot]);
const loot = kernel.services.get('loot');
// Without the empty slot unless a test asks for it.
const api = (over: Record<string, unknown> = {}) =>
	({ ...engineContext(kernel, 'x', 0, { 'loot.rules': { empty: { share: 0 } }, ...over }) }) as never;

describe('loot', () => {
	it('draws by weight until the drops are worth the minimum; a value defaults to the base weight over its own', () => {
		// Base weight 4 (loot.rules.baseWeight): a pebble (9) is worth 4/9, a pearl (1) 4; the nugget says 2.
		const random = seededRandom('loot');
		for (let i = 0; i < 200; i++) {
			const ids = loot.roll(api(), 'test-loot', {}, 3, random);
			const worth = (id: string) => ({ pebble: 4 / 9, pearl: 4, nugget: 2 })[id]!;
			const total = ids.reduce((a, id) => a + worth(id), 0);
			expect(total).toBeGreaterThanOrEqual(3);
			// It stops as soon as it is enough: without the last draw it was not.
			expect(total - worth(ids.at(-1)!)).toBeLessThan(3);
		}
		expect(loot.roll(api(), 'test-loot', {}, 0, random)).toEqual([]);
	});

	it('takes GM weights by pool, groups what can drop for the list, and skips empty pools at once', () => {
		// Only pearls: each is worth the base weight over its own, 4 / 1 (others in the pool do not change that); with base 1, three for 2.5.
		const onlyPearls = api({ 'loot.weights': { 'test-loot': { pebble: 0, nugget: 0 } } });
		expect(loot.roll(onlyPearls, 'test-loot', {}, 2.5, seededRandom('p'))).toEqual(['pearl']);
		const base1 = api({ 'loot.weights': { 'test-loot': { pebble: 0, nugget: 0 } }, 'loot.rules': { baseWeight: 1, empty: { share: 0 } } });
		expect(loot.roll(base1, 'test-loot', {}, 2.5, seededRandom('p'))).toEqual(['pearl', 'pearl', 'pearl']);
		// A drop id of another pool is refused, not taken as a weight here.
		expect(resolveConfig(kernel, { 'loot.weights': { 'test-loot': { 'camp-trinket': 0 } } }).errors).toHaveProperty(['loot.weights']);
		const shown = loot.preview(api(), 'test-loot', {});
		// Shares 9/15, 5/15, 1/15: common, common, uncommon (the nugget has no preview: not listed).
		expect(shown.common.map((x) => x.name)).toEqual(['test-loot.Pebble']);
		expect(shown.uncommon.map((x) => x.name)).toEqual(['test-loot.Pearl']);
		expect(loot.drops('test-loot')).toEqual(['pebble', 'pearl', 'nugget']);
		loot.definePool('test-empty');
		expect(loot.empty('test-empty')).toBe(true);
		expect(loot.roll(api(), 'test-empty', {}, 5, () => 0.5)).toEqual([]);
	});

	it('NPC settlements and attacks on players have pools other plugins fill: a win brings spoils', async () => {
		const fast = {
			'armies.speed': 1e6,
			'armies.minSeconds': 0,
			'pvp.protectionHours': 0,
			// An outpost nobody guards: the raid is won.
			'npc-camps.levels': { 'npc-outpost': { 1: { stockade: 0, lane: {} } } },
		};
		const a = player(fast, kernel);
		const b = player(fast, kernel);
		const ca = await a.start();
		const cb = await b.start();
		await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'cavalry-2', count: 400 }, true);
		const camp = { x: wrap(ca.x + 5), y: ca.y };
		await a.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...camp, level: 1 }, true);
		await a.run(T0, 'armies.send', { from: ca.id, ...camp, units: { 'cavalry-2': 200 } });
		await a.run(T0, 'armies.send', { from: ca.id, x: cb.x, y: cb.y, units: { 'cavalry-2': 200 } });
		const t = T0 + 1_500;
		await a.run(t, 'armies.sync');
		const reports = ((await a.views(t, ['armies.list']))['armies.list'] as ArmyInfo[]).map((x) => x.report!);
		for (const r of reports) {
			expect(r.outcome).toBe('victory');
			// Worth at least 1 from a pool of one thing worth 1: exactly one.
			expect(r.spoils).toEqual([expect.objectContaining({ kind: 'resource', playerId: a.id })]);
		}
	});

	it('an empty slot: a small minimum often ends empty-handed, a large one hardly ever', () => {
		const withEmpty = api({ 'loot.rules': { empty: { share: 0.5, value: 0.1 } } });
		const nothing = (min: number) => {
			const random = seededRandom(`empty:${min}`);
			let none = 0;
			for (let i = 0; i < 2000; i++) if (!loot.roll(withEmpty, 'test-loot', {}, min, random).length) none++;
			return none / 2000;
		};
		// 0.15 needs two empty draws in a row (1/4); 0.45, five (1/32); empty draws are never in the result.
		expect(nothing(0.15)).toBeCloseTo(0.25, 1);
		expect(nothing(0.45)).toBeLessThan(0.06);
		expect(loot.meanDrops(withEmpty, 'test-loot', {}, 0.15, seededRandom('m')).nothing).toBeCloseTo(0.25, 1);
		expect(loot.preview(withEmpty, 'test-loot', {}).common.map((x) => x.name)).toEqual(['test-loot.Pebble']);
	});

	it('every realm task has its own pool in group "realms"; GM weights for the group reach all of them', () => {
		const realms = kernel.services.get('realms');
		const first = realms.list()[0];
		expect(loot.has(`realms.${first.id}.0`)).toBe(true);
		expect(loot.has(`realms.${first.id}.${first.taskCount}`)).toBe(false);
		// Breakthrough stones drop from the 3rd realm on (drops.csv): only in those realms' pools.
		const third = realms.list()[2];
		expect(loot.drops(`realms.${first.id}.0`)).not.toContain('breakthrough-stone');
		expect(loot.drops(`realms.${third.id}.0`)).toContain('breakthrough-stone');
		const onlyScrap = api({
			'loot.weights': { realms: Object.fromEntries(loot.drops('realms').map((id) => [id, id === 'scrap-metal' ? 1 : 0])) },
		});
		expect(new Set(loot.roll(onlyScrap, `realms.${first.id}.0`, { realm: first, task: 0 }, 5, seededRandom('s')))).toEqual(
			new Set(['scrap-metal']),
		);
	});
});
