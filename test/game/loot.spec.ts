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
		// A pool with a drop given a share instead of a weight.
		loot.definePool('test-share');
		loot.addDrop('test-share', { id: 'pebble', weight: 9, preview: { kind: 'item', name: 'Pebble' }, give: give(1) });
		loot.addDrop('test-share', { id: 'pearl', weight: 1, preview: { kind: 'item', name: 'Pearl' }, give: give(1) });
		loot.addDrop('test-share', { id: 'cameo', weight: 1, share: () => 0.14, preview: { kind: 'item', name: 'Cameo' }, give: give(1) });
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

	it('gives a drop declared by share that share of the drops, whatever the others weigh (just below "common")', () => {
		const random = seededRandom('share');
		let cameos = 0;
		let all = 0;
		for (let i = 0; i < 4000; i++)
			for (const id of loot.roll(api(), 'test-share', {}, 0.01, random)) {
				all++;
				if (id === 'cameo') cameos++;
			}
		expect(cameos / all).toBeGreaterThan(0.12);
		expect(cameos / all).toBeLessThan(0.16);
		expect(loot.preview(api(), 'test-share', {}).uncommon.map((x) => x.name)).toContain('test-loot.Cameo');
		// The cavalry levy orders featured in a realm's hardest task (starter-levies featured.csv): soul-valley, tier 2.
		const realm = kernel.services.get('realms').get('soul-valley');
		const pool = `realms.soul-valley.${realm.taskCount - 1}`;
		expect(loot.drops(pool)).toContain('levy-cavalry-2');
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
		// Every drop is in every task's pool, weighted by the table realms.pools: breakthrough stones only from the 3rd
		// realm on (drops.csv), 0 before.
		const third = realms.list()[2];
		const table = (api() as { config: Record<string, unknown> }).config['realms.pools'] as Record<
			string,
			{ minValue: number; drops: Record<string, { weight: number; value: number }> }
		>;
		expect(loot.drops(`realms.${first.id}.0`)).toContain('breakthrough-stone');
		expect(table[`${first.id}.0`].drops['breakthrough-stone'].weight).toBe(0);
		expect(table[`${third.id}.0`].drops['breakthrough-stone'].weight).toBeGreaterThan(0);
		expect(table[`${first.id}.0`].minValue).toBeGreaterThan(0);
		// The GM puts it into realm 1's first task, alone, worth 2: two draws reach 4.
		const gm = api({
			'realms.pools': {
				[`${first.id}.0`]: {
					drops: Object.fromEntries(
						Object.keys(table[`${first.id}.0`].drops).map((id) => [id, { weight: id === 'breakthrough-stone' ? 1 : 0 }]),
					),
				},
			},
		});
		const rolled = loot.roll(gm, `realms.${first.id}.0`, { realm: first, task: 0 }, 4, seededRandom('b'));
		expect(new Set(rolled)).toEqual(new Set(['breakthrough-stone']));
		// Equipment: a drop per piece and colour (the GM weighs each), shown to players once per set and colour.
		const pool = table[`${first.id}.0`].drops;
		expect(pool['starter-equipment.azure-edge-weapon.white'].weight).toBeGreaterThan(0);
		expect(pool['starter-equipment.azure-edge-helm.white'].weight).toBeGreaterThan(0);
		const helmOnly = api({
			'realms.pools': {
				[`${first.id}.0`]: {
					drops: Object.fromEntries(
						Object.keys(pool).map((id) => [id, { weight: id === 'starter-equipment.azure-edge-helm.white' ? 1 : 0 }]),
					),
				},
			},
		});
		expect(new Set(loot.roll(helmOnly, `realms.${first.id}.0`, { realm: first, task: 0 }, 4, seededRandom('h')))).toEqual(
			new Set(['starter-equipment.azure-edge-helm.white']),
		);
		const shown = loot.preview(api(), `realms.${first.id}.0`, { realm: first, task: 0 });
		const whiteAzure = [...shown.common, ...shown.uncommon, ...shown.rare].filter(
			(x) => x.name === 'starter-equipment.Azure Edge set' && x.rarity === 'white',
		);
		expect(whiteAzure).toHaveLength(1);
		const worth = api({ 'realms.pools': { [`${first.id}.0`]: { drops: { 'breakthrough-stone': { weight: 1, value: 2 } } } } });
		expect(
			((worth as { config: Record<string, unknown> }).config['realms.pools'] as typeof table)[`${first.id}.0`].drops['breakthrough-stone'],
		).toEqual({ weight: 1, value: 2 });
		const onlyScrap = api({
			'loot.weights': { realms: Object.fromEntries(loot.drops('realms').map((id) => [id, id === 'scrap-metal' ? 1 : 0])) },
		});
		expect(new Set(loot.roll(onlyScrap, `realms.${first.id}.0`, { realm: first, task: 0 }, 5, seededRandom('s')))).toEqual(
			new Set(['scrap-metal']),
		);
	});
});
