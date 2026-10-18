/** Opaque research (gameplay.md §14): the arithmetic, the Shuangqing Temple, applications, approving and ending projects. */
import { describe, expect, it } from 'vitest';
import { createKernel, definePlugin, engineContext, fields, GameError, resolveConfig, seededRandom, shape } from '../../src/kernel';
import { plugins } from '../../src/plugins';
import { reduction } from '../../src/plugins/opaque-research';
import {
	allocate,
	choose,
	DIMENSIONS,
	groupOf,
	groupSteps,
	nextThreshold,
	offsetDraw,
	passed,
	pointRange,
	sprintShare,
	type Tuning,
} from '../../src/plugins/opaque-research/logic';
import type { OpaqueStatus, OpaqueTexts } from '../../src/shared/api';
import { T0, db, player } from '../helpers';

/** Places buildings in the capital at a level and gives it heroes posted at the institute (what tests need set up). */
const setup = definePlugin({
	id: 'test-opaque',
	version: '0.0.0',
	description: 'test helpers',
	dependsOn: ['buildings', 'heroes', 'settlements'],
	setup(ctx) {
		const buildings = ctx.services.get('buildings');
		const heroes = ctx.services.get('heroes');
		const settlements = ctx.services.get('settlements');
		ctx.commands.add<{ building: string; level: number }>({
			type: 'test-opaque.place',
			privileged: true,
			description: 'test',
			parse: shape({ building: fields.id(), level: fields.int(1, 100) }),
			async execute(api, { building, level }) {
				const c = (await settlements.capital(api, api.playerId))!;
				const placed = await buildings.placed(api, c.id);
				const category = buildings.get(building).category;
				for (const d of c.districts) {
					if (!settlements.district(c, d.id).template.accepts.includes(category)) continue;
					for (let slot = 0; slot < d.slots; slot++)
						if (!placed.get(d.id)?.has(slot)) return buildings.place(api, c.id, d.id, slot, building, level);
				}
				throw new Error('no free slot');
			},
		});
		ctx.commands.add<{ learning: number; strategy: number; exp: number }>({
			type: 'test-opaque.scholar',
			privileged: true,
			description: 'test',
			parse: shape({ learning: fields.int(0, 1000), strategy: fields.int(0, 1000), exp: fields.int(0, 1e9) }),
			async execute(api, { learning, strategy, exp }) {
				const c = (await settlements.capital(api, api.playerId))!;
				const h = await heroes.grant(
					api,
					api.playerId,
					c.id,
					{ venue: 'academy', attrs: { might: strategy, leadership: strategy, strategy, governance: learning, learning, charm: learning } },
					seededRandom(String(api.now)),
				);
				if (exp) await heroes.grantExp(api, h.id, exp);
				await heroes.assign(api, h.id, 'scholar', c.id);
			},
		});
	},
});
const kernel = createKernel([...plugins, setup]);
const COSTS = { stone: 10, wood: 10, food: 10, metal: 10, gold: 10, seconds: 3600, yuanbao: 5 };
const rules = { 'starter-opaque-research.costs': { 1: COSTS, 2: COSTS, 3: COSTS, 4: COSTS }, 'heroes.cap': 10 };

async function ready(temple = 1, extra: Record<string, unknown> = {}) {
	const p = player({ ...rules, ...extra }, kernel);
	await p.start();
	await p.run(T0, 'test-opaque.place', { building: 'institute', level: 20 }, true);
	if (temple) await p.run(T0, 'test-opaque.place', { building: 'shuangqing-temple', level: temple }, true);
	for (const r of ['stone', 'wood', 'food', 'metal', 'gold']) await p.grant(T0, r, 1000);
	await p.run(T0, 'shop.grant', { amount: 100 }, true);
	return p;
}
const status = async (p: ReturnType<typeof player>, now: number) =>
	(await p.views(now, ['opaque-research.status']))['opaque-research.status'] as OpaqueStatus;
const values = async (playerId: string) => {
	const row = await db
		.prepare('SELECT dims, version FROM opaque_research_values WHERE player_id = ?')
		.bind(playerId)
		.first<{ dims: string; version: number }>();
	return row ? { dims: JSON.parse(row.dims) as number[], version: row.version } : null;
};
const code = async (f: Promise<unknown>) => {
	try {
		await f;
	} catch (e) {
		return (e as GameError).code;
	}
	return null;
};

describe('opaque research: arithmetic', () => {
	it('counts thresholds: the first, then each a ratio of the one before (8, 24, 72, 216 at 8 and 3)', () => {
		expect([0, 7.9, 8, 23.9, 24, 71.9, 72, 216].map((v) => passed(v, [8, 3]))).toEqual([0, 0, 1, 1, 2, 2, 3, 4]);
		expect(nextThreshold(0, [8, 3])).toBe(8);
		expect(nextThreshold(30, [8, 3])).toBe(72);
	});
	it('puts a share on the centre and fills the lowest around it, the points all spent', () => {
		const v = Array<number>(DIMENSIONS).fill(0);
		v[9] = 4;
		v[11] = 2;
		const out = allocate(v, 10, 10, 0.5, 3);
		expect(out[10]).toBe(5);
		// 5 to fill 7..9 and 11..13: the four at 0 rise together (to 1.25, short of 11's 2).
		const around = [7, 8, 9, 11, 12, 13].map((i) => out[i]);
		expect(around.reduce((a, b) => a + b, 0) - 6).toBeCloseTo(5, 1);
		expect(out[9]).toBe(4);
		expect(Math.min(...around)).toBeCloseTo(1.25, 2);
		expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(16, 1);
		// Groups: the steps of all dimensions in each.
		expect(groupSteps(out, 8, [5, 8])[0]).toBe(1);
	});
	it('cuts the ring into any number of groups, as even as can be', () => {
		const sizes = (n: number) =>
			Array.from({ length: n }, (_, g) => Array.from({ length: DIMENSIONS }, (_, i) => i).filter((i) => groupOf(i, n) === g).length);
		expect(sizes(3)).toEqual([86, 85, 85]);
		expect(sizes(8)).toEqual(Array(8).fill(32));
		expect(new Set(sizes(100))).toEqual(new Set([2, 3]));
		expect(groupOf(255, 256)).toBe(255);
		const v = Array<number>(DIMENSIONS).fill(0);
		v[85] = 8;
		v[86] = 24;
		expect(groupSteps(v, 3, [8, 3])).toEqual([1, 2, 0]);
	});
	it('treats the dimensions as a ring: the last one neighbours the first', () => {
		const out = allocate(Array<number>(DIMENSIONS).fill(0), 0, 12, 0.5, 3);
		expect([253, 254, 255, 1, 2, 3].map((i) => out[i])).toEqual([1, 1, 1, 1, 1, 1]);
		expect(out[4]).toBe(0);
		expect(out[252]).toBe(0);
	});
	it('gives a review rate that matches how often the points get past the promised threshold', () => {
		const t: Tuning = {
			thresholds: [8, 3],
			points: { 1: 8, 2: 16, 3: 32, 4: 64 },
			spread: { min: 0.5, max: 2, full: 300, jitter: 0.2 },
			sprint: { base: 0.5, perCunning: 0.003, lead: 0.5, min: 0.2, max: 0.8, window: 3 },
			avoid: { depth: 0.5, sigma: 3 },
			fixedRate: 0.3,
		};
		const r = seededRandom('rate');
		const v = Array.from({ length: DIMENSIONS }, () => Math.floor(r() * 4));
		const range = pointRange(1, 150, t);
		const c = choose(v, range, 50, [], t, r);
		expect(c.promise).toBe(true);
		const share = sprintShare(v, c.target, 50, t);
		const next = passed(v[c.target], [8, 3]) + 1;
		let hits = 0;
		for (let i = 0; i < 4000; i++) {
			const pts = range[0] + (range[1] - range[0]) * r();
			if (passed(allocate(v, c.target, pts, share, 3)[c.target], [8, 3]) >= next) hits++;
		}
		expect(Math.abs(hits / 4000 - c.rate)).toBeLessThan(0.04);
		// Nothing in reach: the lowest dimension, at the fixed rate.
		expect(choose(v, [0.1, 0.2], 50, [], t, r)).toMatchObject({ promise: false, rate: 0.3 });
	});
	it('lands within ±max of the target and lowers by 1 / (1 + percent)', () => {
		const r = seededRandom('x');
		const draws = Array.from({ length: 500 }, () => offsetDraw(r, 1, 2));
		expect(Math.max(...draws.map(Math.abs))).toBe(2);
		expect(draws.filter((d) => d === 0).length).toBeGreaterThan(120);
		expect(reduction(100)).toBe(0.5);
	});
});

describe('opaque research: projects', () => {
	it('works nothing out without the temple, and the temple needs the institute and palace', async () => {
		const p = await ready(0);
		await p.run(T0, 'test-opaque.scholar', { learning: 100, strategy: 50, exp: 0 }, true);
		expect(await status(p, T0)).toMatchObject({ unlocked: 0, applications: [], projects: [] });
		const c = await p.detail(T0);
		const inner = c.districts.find((d) => d.type === 'inner')!;
		for (const r of ['stone', 'wood', 'food', 'metal', 'gold']) await p.grant(T0, r, 1e7);
		const { results } = await db.prepare('SELECT slot FROM buildings_slots WHERE district_id = ?').bind(inner.id).all<{ slot: number }>();
		const free = Array.from({ length: 50 }, (_, i) => i).find((i) => !results.some((r) => r.slot === i))!;
		const refused = await p.construct(T0, c.id, inner.id, free, 'shuangqing-temple').catch((e: GameError) => e);
		expect(refused).toMatchObject({ code: 'blocked', message: 'starter-opaque-research.Requires {0} Lv {1}' });
	});

	it('takes applications from posted heroes, approves at a cost, ends them and grows the hidden values', async () => {
		const p = await ready();
		await p.run(T0, 'test-opaque.scholar', { learning: 300, strategy: 300, exp: 0 }, true);
		const s = await status(p, T0);
		expect(s.unlocked).toBe(1);
		expect(s.max).toBe(1);
		expect(s.applications).toHaveLength(1);
		const a = s.applications[0];
		expect(a).toMatchObject({ tier: 1, cost: { stone: 10 }, yuanbao: 5, seconds: 3600 });
		// The same application while nothing changes (worked out, not stored).
		expect((await status(p, T0 + 60_000)).applications[0]).toEqual(a);

		expect(await code(p.run(T0, 'opaque-research.approve', { hero: a.hero, season: a.season, version: a.version + 1 }))).toBe('stale');
		await p.run(T0, 'opaque-research.approve', { hero: a.hero, season: a.season, version: a.version });
		expect((await p.pool(T0)).amounts.stone).toBe(1490);
		const after = await status(p, T0);
		expect(after.applications).toHaveLength(0);
		expect(after.projects).toMatchObject([{ hero: a.hero, tier: 1 }]);
		// Hosting: kept on its post.
		expect(await code(p.run(T0, 'heroes.assign', { hero: a.hero, duty: 'idle', target: null }))).toBe('blocked');

		const done = T0 + 3_600_000 + 1;
		const before = (await values(p.id))!;
		await p.run(done, 'resources.grant', { resource: 'stone', amount: 1 }, true);
		const v = (await values(p.id))!;
		expect(v.version).toBeGreaterThan(before.version);
		// The stored group steps (read on every sync) are those worked out from the values.
		const stored = await db.prepare('SELECT steps FROM opaque_research_values WHERE player_id = ?').bind(p.id).first<{ steps: string }>();
		expect(JSON.parse(stored!.steps)).toEqual(groupSteps(v.dims, 8, [8, 3]));
		const sum = v.dims.reduce((x, y) => x + y, 0);
		// Tier 1: 8 x up to 2 (a points score of 300) ± 20%, all of it spent.
		expect(sum).toBeGreaterThan(8 * 2 * 0.8 - 0.1);
		expect(sum).toBeLessThan(8 * 2 * 1.2 + 0.1);
		const end = await status(p, done);
		expect(end.projects).toHaveLength(0);
		// Free again, and writing the next (tier 2 needs level 35: still tier 1).
		expect(end.applications).toMatchObject([{ hero: a.hero, tier: 1 }]);
		const row = await db.prepare('SELECT hosted, max_tier FROM opaque_research_heroes WHERE hero_id = ?').bind(a.hero).first();
		expect(row).toEqual({ hosted: 1, max_tier: 1 });
	});

	it('approves as many at a time as the temple level, and refuses without coupons', async () => {
		const p = await ready();
		await p.run(T0, 'test-opaque.scholar', { learning: 100, strategy: 50, exp: 0 }, true);
		await p.run(T0, 'test-opaque.scholar', { learning: 100, strategy: 50, exp: 0 }, true);
		const [a, b] = (await status(p, T0)).applications;
		await p.run(T0, 'opaque-research.approve', { hero: a.hero, season: a.season, version: a.version });
		// The other application is written again (the project under way is avoided): its version moved on.
		const b2 = (await status(p, T0)).applications.find((x) => x.hero === b.hero)!;
		expect(b2.version).toBe(b.version + 1);
		expect(await code(p.run(T0, 'opaque-research.approve', { hero: b.hero, season: b2.season, version: b2.version }))).toBe('limit');

		const q = await ready(1);
		await q.run(T0, 'shop.grant', { amount: -100 }, true);
		await q.run(T0, 'test-opaque.scholar', { learning: 100, strategy: 50, exp: 0 }, true);
		const c = (await status(q, T0)).applications[0];
		expect(await code(q.run(T0, 'opaque-research.approve', { hero: c.hero, season: c.season, version: c.version }))).toBe(
			'insufficient_coupons',
		);
	});

	it('lets only one of two approvals at once through when one more would pass the limit', async () => {
		const p = await ready();
		await p.run(T0, 'test-opaque.scholar', { learning: 100, strategy: 50, exp: 0 }, true);
		await p.run(T0, 'test-opaque.scholar', { learning: 100, strategy: 50, exp: 0 }, true);
		const apps = (await status(p, T0)).applications;
		const results = await Promise.allSettled(
			apps.map((a) => p.run(T0, 'opaque-research.approve', { hero: a.hero, season: a.season, version: a.version })),
		);
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect((await status(p, T0)).projects).toHaveLength(1);
		expect((await p.pool(T0)).amounts.stone).toBe(1490);
	});

	it('gives each group its bonus by the thresholds passed: currency production, counters... (8 groups by default)', async () => {
		const p = await ready();
		const c = (await p.mine(T0))[0];
		const dims = Array<number>(DIMENSIONS).fill(0);
		dims[32] = 24; // group 2 (currency production): two thresholds
		dims[200] = 8; // group 7 (counters): one
		await db
			.prepare('INSERT INTO opaque_research_values (player_id, dims, steps, version) VALUES (?, ?, ?, 1)')
			.bind(p.id, JSON.stringify(dims), JSON.stringify(groupSteps(dims, 8, [8, 3])))
			.run();
		const s = await status(p, T0);
		expect(s.steps).toEqual([0, 2, 0, 0, 0, 0, 1, 0]);
		const texts = (await kernel.statics
			.find((x) => x.id === 'opaque-research.texts')!
			.compute({ rules: { config: resolveConfig(kernel, p.overrides).values } as never, db })) as OpaqueTexts;
		expect(texts.groups[1]).toEqual([{ bonus: 'output:gold', step: 2 }]);
		expect(texts.groups.filter((g) => g.some((b) => b.bonus === 'troop-upkeep'))).toHaveLength(2);
		expect(Object.keys(texts.bonuses)).toEqual(expect.arrayContaining(['troop-upkeep:t3-food', 'attack:cavalry', 'defense-upkeep:gold']));
		const api = {
			...engineContext(kernel, p.id, T0, p.overrides),
			db,
			services: kernel.services,
			memo: (_k: string, l: () => Promise<unknown>) => l(),
			isFresh: () => false,
			peek: () => undefined,
			fresh: () => {},
		} as never;
		const stats = kernel.services.get('stats');
		expect(await stats.get(api, 'resources.output.gold', `settlement:${c.id}`)).toBeCloseTo(1.04, 6);
		expect(await stats.get(api, 'resources.output.stone', `settlement:${c.id}`)).toBe(1);
	});

	it('lets the GM give a group a fine-grained bonus: tier-1 troops eat half as much food at 100%', async () => {
		const groups = Array.from({ length: 8 }, () => [] as { bonus: string; step: number }[]);
		groups[0] = [{ bonus: 'troop-upkeep:t1-food', step: 100 }];
		const p = await ready(1, { 'opaque-research.groups': { count: 8, groups } });
		const c = (await p.mine(T0))[0];
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 100 }, true);
		const before = (await p.pool(T0)).upkeep;
		const dims = Array<number>(DIMENSIONS).fill(0);
		dims[0] = 8;
		await db
			.prepare('INSERT INTO opaque_research_values (player_id, dims, steps, version) VALUES (?, ?, ?, 1)')
			.bind(p.id, JSON.stringify(dims), JSON.stringify(groupSteps(dims, 8, [8, 3])))
			.run();
		const after = (await p.pool(T0)).upkeep;
		expect(before.food).toBeGreaterThan(0);
		expect(after.food).toBeCloseTo(before.food / 2, 6);
		// Other resources of the same troops keep their upkeep.
		for (const r of Object.keys(before)) if (r !== 'food') expect(after[r]).toBeCloseTo(before[r], 6);
		// A group may only name known bonuses, each once; one entry a group.
		const errors = (v: unknown) => Object.keys(resolveConfig(kernel, { 'opaque-research.groups': v }).errors);
		expect(errors({ count: 8, groups })).toEqual([]);
		const at = (g: { bonus: string; step: number }[]) => ({ count: 8, groups: [g, ...groups.slice(1)] });
		expect(errors(at([{ bonus: 'no-such-bonus', step: 1 }]))).toEqual(['opaque-research.groups']);
		expect(
			errors(
				at([
					{ bonus: 'counter', step: 1 },
					{ bonus: 'counter', step: 2 },
				]),
			),
		).toEqual(['opaque-research.groups']);
		expect(errors({ count: 4, groups })).toEqual(['opaque-research.groups']);
		expect(errors({ count: 3, groups: [[], [{ bonus: 'counter', step: 1 }], []] })).toEqual([]);
		expect(errors({ count: 256, groups: Array.from({ length: 256 }, () => []) })).toEqual([]);
		expect(errors({ count: 257, groups: Array.from({ length: 257 }, () => []) })).toEqual(['opaque-research.groups']);
		expect(errors({ count: 0, groups: [] })).toEqual(['opaque-research.groups']);
	});

	it('caps the tier by the temple and by the tiers granted before; a rejection waits for the next season', async () => {
		const p = await ready(5);
		// A hero far past level 45 starts at tier 1 all the same.
		await p.run(T0, 'test-opaque.scholar', { learning: 100, strategy: 50, exp: 1e9 }, true);
		const a = (await status(p, T0)).applications[0];
		expect(a.tier).toBe(1);
		await p.run(T0, 'opaque-research.reject', { hero: a.hero, season: a.season });
		expect((await status(p, T0)).applications).toHaveLength(0);
		const tomorrow = (a.season + 1) * 86_400_000 + 1;
		const n = (await status(p, tomorrow)).applications[0];
		await p.run(tomorrow, 'opaque-research.approve', { hero: n.hero, season: n.season, version: n.version });
		const later = tomorrow + 3_600_000 + 1;
		// Tier 1 granted: tier 2 next, which level 5 unlocks; not tier 3.
		expect((await status(p, later)).applications[0].tier).toBe(2);
	});
});
