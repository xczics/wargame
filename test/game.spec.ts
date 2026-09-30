/**
 * Game rules through the engine against a real (local) D1, with a fake clock.
 * Each test uses fresh players (and capitals at random map spots), so tests never share rows.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { computeViews, createKernel, definePlugin, engineContext, executeCommand, GameError, type Kernel } from '../src/kernel';
import { plugins } from '../src/plugins';
import { wrap } from '../src/plugins/world-map';
import type { ArmyInfo, GarrisonInfo, MapTile, ResourcePool, SettlementDetail, SettlementSummary } from '../src/shared/api';

const db = env.DB;
const T0 = 2_000_000_000_000;
const defaultKernel = createKernel(plugins);

function player(extra?: Record<string, unknown>, kernel: Kernel = defaultKernel) {
	// No built-in settlement income, so production numbers below come only from buildings.
	const overrides = { 'player-settlements.baseProduction': {}, ...extra };
	const id = crypto.randomUUID();
	const at = (now: number, privileged = false) => engineContext(kernel, id, now, overrides, privileged);
	const views = async (now: number, ids: string[], params: Record<string, string> = {}) =>
		(await computeViews(kernel, db, at(now), ids, params)).views as Record<string, unknown>;
	const p = {
		id,
		run: (now: number, type: string, payload: unknown = null, privileged = false) =>
			executeCommand(kernel, db, at(now, privileged), type, payload),
		views,
		detail: async (now: number, settlement?: string) =>
			(await views(now, ['settlements.detail'], settlement ? { settlement } : {}))['settlements.detail'] as SettlementDetail,
		pool: async (now: number, settlement?: string) =>
			(await views(now, ['resources.pool'], settlement ? { settlement } : {}))['resources.pool'] as ResourcePool,
		mine: async (now: number) => (await views(now, ['settlements.mine']))['settlements.mine'] as SettlementSummary[],
		/** Found the capital and return its detail. */
		async start(now = T0) {
			await p.run(now, 'settlements.foundCapital');
			return p.detail(now);
		},
		construct: (now: number, settlement: string, district: string, slot: number, building?: string) =>
			p.run(now, 'buildings.construct', { settlement, district, slot, building }),
		grant: (now: number, resource: string, amount: number, settlement?: string) =>
			p.run(now, 'resources.grant', { resource, amount, settlement }, true),
	};
	return p;
}

const inner = (d: SettlementDetail) => d.districts.find((x) => x.type === 'inner')!;
const outer = (d: SettlementDetail, i = 0) => d.districts.filter((x) => x.type === 'outer')[i];

describe('capital', () => {
	it('is founded with an inner city, one outer city and the starting resources', async () => {
		const p = player();
		const capital = await p.start();
		expect(capital.kind).toBe('capital');
		expect(capital.districts.map((d) => d.type)).toEqual(['inner', 'outer']);
		expect(inner(capital).slots).toHaveLength(12);
		expect(outer(capital).slots.length).toBeGreaterThanOrEqual(3);
		expect(outer(capital).slots.length).toBeLessThanOrEqual(6);
		expect((await p.pool(T0)).amounts).toEqual({ food: 500, wood: 500, stone: 500, gold: 200 });
		await expect(p.run(T0, 'settlements.foundCapital')).rejects.toThrow(/already have a capital/);
	});
});

describe('construction', () => {
	it('takes time, and production switches on exactly when it finishes', async () => {
		const p = player();
		const c = await p.start();
		await p.construct(T0, c.id, outer(c).id, 0, 'farm'); // 40 food + 60 wood, 10 s
		let d = await p.detail(T0 + 5_000);
		expect(outer(d).slots[0].construction).toMatchObject({ building: 'farm', targetLevel: 1, finishesAt: T0 + 10_000 });
		expect((await p.pool(T0 + 5_000)).amounts.food).toBe(460);

		// 30 s after start = 20 s of production at 1 food/s.
		const pool = await p.pool(T0 + 30_000);
		expect(pool.amounts.food).toBeCloseTo(480);
		expect(pool.rates.food).toBe(1);
		d = await p.detail(T0 + 30_000);
		expect(outer(d).slots[0]).toMatchObject({ current: { building: 'farm', level: 1 }, construction: null });
		expect(outer(d).slots[0].current?.effects).toEqual({ produces: { food: 1 }, stats: {} });
		expect(outer(d).slots[0].options[0]).toMatchObject({ level: 2, effects: { produces: { food: 2 } } });
		const warehouse = inner(d).slots[0].options.find((o) => o.building === 'warehouse');
		expect(warehouse?.effects).toEqual({ produces: {}, stats: { 'resources.capacity': 2000, 'pvp.protected': 500 } });
	});

	it('persists completion when a later command runs', async () => {
		const p = player();
		const c = await p.start();
		await p.construct(T0, c.id, outer(c).id, 0, 'farm');
		await p.construct(T0 + 20_000, c.id, outer(c).id, 0); // upgrade to 2, implies level 1 was stored
		const row = await db.prepare('SELECT level FROM buildings_slots WHERE district_id = ?').bind(outer(c).id).first<{ level: number }>();
		expect(row?.level).toBe(1);
		const events = await db
			.prepare('SELECT COUNT(*) AS n FROM timeline_events WHERE entity = ?')
			.bind(`settlement:${c.id}`)
			.first<{ n: number }>();
		expect(events?.n).toBe(1); // only the level-2 completion is pending
	});

	it('enforces district rules: resources outside, everything else inside', async () => {
		const p = player();
		const c = await p.start();
		await expect(p.construct(T0, c.id, inner(c).id, 0, 'farm')).rejects.toThrow(/cannot be built in this district/);
		await expect(p.construct(T0, c.id, outer(c).id, 0, 'warehouse')).rejects.toThrow(/cannot be built in this district/);
		await expect(p.construct(T0, c.id, inner(c).id, 0, 'town-hall')).rejects.toThrow(/only be built in: city/);
		await p.construct(T0, c.id, inner(c).id, 0, 'warehouse');
	});

	it('limits simultaneous constructions and unique buildings', async () => {
		const p = player();
		const c = await p.start();
		await p.grant(T0, 'gold', 1000);
		await p.construct(T0, c.id, inner(c).id, 0, 'palace');
		await p.construct(T0, c.id, inner(c).id, 1, 'warehouse');
		await expect(p.construct(T0, c.id, inner(c).id, 2, 'barracks')).rejects.toThrow(/queue full/);
		await expect(p.construct(T0 + 60_000, c.id, inner(c).id, 3, 'palace')).rejects.toThrow(/Only one Palace/);
	});

	it('cancels a construction with a partial refund', async () => {
		const p = player();
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'warehouse'); // 150 wood + 100 stone, 20 s
		await p.run(T0 + 5_000, 'buildings.cancel', { settlement: c.id, district: inner(c).id, slot: 0 });
		const pool = await p.pool(T0 + 60_000);
		expect(pool.amounts).toMatchObject({ wood: 350 + 75, stone: 400 + 50 });
		expect((await p.detail(T0 + 60_000)).districts[0].slots[0]).toMatchObject({ current: null, construction: null });
		const events = await db
			.prepare('SELECT COUNT(*) AS n FROM timeline_events WHERE entity = ?')
			.bind(`settlement:${c.id}`)
			.first<{ n: number }>();
		expect(events?.n).toBe(0);
		await expect(p.run(T0 + 60_000, 'buildings.cancel', { settlement: c.id, district: inner(c).id, slot: 0 })).rejects.toThrow(
			/Nothing is being built/,
		);
	});

	it('frees queue places when constructions finish', async () => {
		const p = player();
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'warehouse'); // 20 s
		await p.construct(T0, c.id, outer(c).id, 0, 'farm'); // 10 s
		await expect(p.construct(T0, c.id, outer(c).id, 1, 'farm')).rejects.toThrow(/queue full/);
		expect((await p.detail(T0 + 15_000)).limits.queueUsed).toBe(1);
		await p.construct(T0 + 15_000, c.id, outer(c).id, 1, 'farm');
	});

	it('costs follow the planning table, then grow from its last row', async () => {
		const buildings = defaultKernel.services.get('buildings');
		const api = { config: engineContext(defaultKernel, 'x', 0).config } as never;
		expect(buildings.levelCost(api, 'farm', 7)).toEqual({ cost: { food: 880, wood: 1200, stone: 400 }, seconds: 2100 });
		const g = 1.3 ** 2; // two levels past the 7-row table
		expect(buildings.levelCost(api, 'farm', 9)).toEqual({
			cost: { food: Math.ceil(880 * g), wood: Math.ceil(1200 * g), stone: Math.ceil(400 * g) },
			seconds: Math.ceil(2100 * 1.25 ** 2),
		});
	});

	it('lets research plugins gate levels, and breakthroughs pass the regular cap', async () => {
		const gate = definePlugin({
			id: 'test-research',
			version: '0',
			dependsOn: ['buildings'],
			setup(ctx) {
				ctx.services
					.get('buildings')
					.addGate(async (_api, req) => (req.building.id === 'warehouse' && req.toLevel >= 2 ? 'Requires Masonry' : null));
			},
		});
		const p = player({ 'buildings.rules': { warehouse: { cap: 1 } } }, createKernel([...plugins, gate]));
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'warehouse');
		const slot = (await p.detail(T0 + 60_000)).districts[0].slots[0];
		expect(slot.current).toMatchObject({ level: 1, cap: 1 });
		expect(slot.options[0].blocked).toMatch(/Level cap 1/);
		await p.run(T0 + 60_000, 'buildings.raiseCap', { settlement: c.id, district: inner(c).id, slot: 0, by: 3 }, true);
		expect((await p.detail(T0 + 60_000)).districts[0].slots[0].options[0].blocked).toBe('Requires Masonry');
	});
});

describe('resource pools', () => {
	it('upkeep digs below zero down to the debt limit, but spending never does', async () => {
		const upkeep = definePlugin({
			id: 'test-upkeep',
			version: '0',
			dependsOn: ['resources'],
			setup(ctx) {
				ctx.services
					.get('resources')
					.addConsumer(async (_api, holder): Promise<Record<string, number>> => (holder.startsWith('settlement:') ? { gold: 1 } : {}));
			},
		});
		const p = player({ 'resources.debtLimit': { gold: 50 } }, createKernel([...plugins, upkeep]));
		const c = await p.start(); // 200 gold, -1/s
		expect((await p.pool(T0 + 100_000)).amounts.gold).toBeCloseTo(100);
		expect((await p.pool(T0 + 230_000)).amounts.gold).toBeCloseTo(-30);
		expect((await p.pool(T0 + 3600_000)).amounts.gold).toBeCloseTo(-50);
		// In debt: nothing that costs gold can be bought, and the pool persists negative.
		await expect(p.construct(T0 + 3600_000, c.id, inner(c).id, 0, 'palace')).rejects.toThrow(/Not enough/);
		await p.run(T0 + 3600_000, 'resources.grant', { resource: 'gold', amount: 20 }, true);
		expect((await p.pool(T0 + 3600_000)).amounts.gold).toBeCloseTo(-30);
	});

	it('fires a depletion event at the exact moment upkeep drains a resource', async () => {
		const seen: { resource: string; at: number }[] = [];
		const army = definePlugin({
			id: 'test-army',
			version: '0',
			dependsOn: ['resources'],
			setup(ctx) {
				const resources = ctx.services.get('resources');
				resources.addConsumer(async (_api, holder): Promise<Record<string, number>> =>
					holder.startsWith('settlement:') ? { gold: 2 } : {},
				);
				resources.onDepleted(async (_api, e) => void seen.push({ resource: e.resource, at: e.at }));
			},
		});
		const p = player({ 'resources.debtLimit': { gold: 10 } }, createKernel([...plugins, army]));
		const c = await p.start(); // 200 gold at -2/s: empty at T0 + 100 s
		const due = await db
			.prepare("SELECT due_at FROM timeline_events WHERE entity = ? AND type = 'resources.depleted'")
			.bind(`settlement:${c.id}`)
			.first<{ due_at: number }>();
		expect(due?.due_at).toBe(T0 + 100_000);
		// Due events are processed when the settlement's state is next used, e.g. by building something.
		await p.construct(T0 + 150_000, c.id, outer(c).id, 0, 'farm');
		expect(seen).toContainEqual({ resource: 'gold', at: T0 + 100_000 });
		expect((await p.pool(T0 + 150_000)).amounts.gold).toBeCloseTo(-10);
	});

	it('net rate = production x bonus factor - upkeep', async () => {
		const economy = definePlugin({
			id: 'test-economy',
			version: '0',
			dependsOn: ['resources', 'stats'],
			setup(ctx) {
				ctx.services
					.get('resources')
					.addConsumer(async (_api, holder): Promise<Record<string, number>> => (holder.startsWith('settlement:') ? { food: 0.5 } : {}));
				ctx.services.get('stats').contribute('resources.productionFactor', async () => ({ percent: 50 }));
			},
		});
		const p = player({}, createKernel([...plugins, economy]));
		const c = await p.start();
		await p.construct(T0, c.id, outer(c).id, 0, 'farm'); // 1 food/s once built at T0+10s
		const pool = await p.pool(T0 + 20_000);
		expect(pool.rates.food).toBeCloseTo(1 * 1.5 - 0.5);
		// 0-10 s: upkeep only (-0.5/s), 10-20 s: +1/s net.
		expect(pool.amounts.food).toBeCloseTo(460 - 5 + 10);
	});

	it('capitals have a small built-in income, so spending everything never soft-locks', async () => {
		const p = player({ 'player-settlements.baseProduction': { capital: { wood: 1 } } });
		await p.start();
		await p.run(T0, 'resources.grant', { resource: 'wood', amount: -500 }, true);
		expect((await p.pool(T0 + 60_000)).amounts.wood).toBeCloseTo(60);
	});

	it('stop growing at the storage cap, which warehouses raise', async () => {
		const p = player({ 'resources.baseCapacity': 600 });
		const c = await p.start();
		await p.construct(T0, c.id, outer(c).id, 0, 'farm');
		expect((await p.pool(T0 + 3600_000)).amounts.food).toBe(600);
		await p.construct(T0 + 3600_000, c.id, inner(c).id, 0, 'warehouse');
		expect((await p.pool(T0 + 3600_000 + 30_000)).capacity).toBe(2600);
	});
});

describe('outer cities', () => {
	it('fill the first ring up to the research limit; items go further, onto the second ring', async () => {
		const p = player({ 'settlements.outerCost': { food: 0 } });
		const c = await p.start();
		const addOuter = async (privileged = false) => {
			const d = await p.detail(T0);
			const forms = (await p.views(T0, ['ui.forms'], { placement: 'settlement', settlement: d.id }))['ui.forms'] as {
				command: string;
				fields: { name: string; options?: { value: string }[] }[];
			}[];
			const form = forms.find((f) => f.command === 'settlements.addOuter');
			const svc = defaultKernel.services.get('settlements');
			const candidates = await svc.outerCandidates(
				{
					...engineContext(defaultKernel, p.id, T0),
					db,
					services: defaultKernel.services,
					memo: (_k: string, l: () => Promise<unknown>) => l(),
				} as never,
				(await svc.get({ db, memo: (_k: string, l: () => Promise<unknown>) => l() } as never, d.id))!,
			);
			const tile = candidates[0];
			await p.run(
				T0,
				privileged ? 'settlements.addOuterBeyondTech' : 'settlements.addOuter',
				{ settlement: d.id, x: tile.x, y: tile.y },
				privileged,
			);
			return form;
		};
		expect(await addOuter()).toBeTruthy();
		await addOuter(); // 3 = research limit
		await expect(addOuter()).rejects.toThrow(/Research more/);
		for (let i = 0; i < 5; i++) await addOuter(true); // items: up to 8 = the full 3x3
		const d = await p.detail(T0);
		const ring = (t: { x: number; y: number }) => Math.max(Math.abs(wrap(t.x - d.x)), Math.abs(wrap(t.y - d.y)));
		expect(d.districts.filter((x) => x.type === 'outer').map(ring)).toEqual(Array(8).fill(1));
		await addOuter(true); // ninth: second ring
		expect(ring((await p.detail(T0)).districts.at(-1)!)).toBe(2);
	});
});

describe('founding and the map', () => {
	it('founds a fortress across the map seam and shows it in a wrapped window', async () => {
		const p = player();
		const c = await p.start();
		await p.grant(T0, 'food', 1000);
		await p.grant(T0, 'wood', 1000);
		await p.grant(T0, 'stone', 1000);
		// Pick a free tile on the seam corner for this test's own fortress.
		let tile = { x: 512, y: 512 };
		for (let i = 0; ; i++) {
			const t = { x: 512, y: wrap(512 + i * 7) };
			const taken = await db.prepare('SELECT 1 FROM world_map_tiles WHERE x = ? AND y = ?').bind(t.x, t.y).first();
			if (!taken) {
				tile = t;
				break;
			}
		}
		await p.run(T0, 'settlements.found', { from: c.id, kind: 'fortress-resource', x: tile.x, y: tile.y, name: 'Edge' });
		const fortress = (await p.mine(T0)).find((s) => s.name === 'Edge')!;
		expect(fortress).toMatchObject({ kind: 'fortress-resource', x: 512, y: tile.y, outer: 0 });

		const window = (await p.views(T0, ['settlements.map'], { x: '-511', y: String(tile.y), r: '1' }))['settlements.map'] as MapTile[];
		expect(window).toContainEqual(expect.objectContaining({ x: 512, y: tile.y, name: 'Edge', centre: true }));

		const f = await p.detail(T0, fortress.id);
		await expect(p.construct(T0, f.id, f.districts[0].id, 0, 'palace')).rejects.toThrow(GameError);
		await p.construct(T0, f.id, f.districts[0].id, 0, 'farm');
		await expect(p.run(T0, 'settlements.found', { from: c.id, kind: 'fortress-resource', x: tile.x, y: tile.y })).rejects.toThrow(
			/already occupied/,
		);
	});
});

describe('research', () => {
	it('gates building levels in bands and adds stat bonuses', async () => {
		const p = player({
			'buildings.speed': 1e6,
			'resources.initial': { food: 1e6, wood: 1e6, stone: 1e6, gold: 1e6 },
			'resources.baseCapacity': 1e7,
		});
		const c = await p.start();
		// Instant-ish builds (speed 1e6 -> 1 s each), one after another.
		for (let lv = 1; lv <= 5; lv++) await p.construct(T0 + lv * 2_000, c.id, outer(c).id, 0, 'farm');
		const at = T0 + 20_000;
		const farm = (await p.detail(at)).districts.find((d) => d.type === 'outer')!.slots[0];
		expect(farm.current?.level).toBe(5);
		expect(farm.options[0].blocked).toBe('Requires Agriculture 1');
		await p.run(at, 'research.setLevel', { tech: 'agriculture', level: 1 }, true);
		expect((await p.detail(at)).districts.find((d) => d.type === 'outer')!.slots[0].options[0].blocked).toBeUndefined();

		expect((await p.detail(at)).limits.outerTech).toBe(3);
		await p.run(at, 'research.setLevel', { tech: 'administration', level: 3 }, true);
		expect((await p.detail(at)).limits.outerTech).toBe(6);
		await p.run(at, 'research.setLevel', { tech: 'economics', level: 2 }, true);
		expect((await p.pool(at)).factor).toBeCloseTo(1.1);
	});

	it('runs in institutes: one queue per settlement, never the same tech twice at once', async () => {
		const rich = { food: 1e5, wood: 1e5, stone: 1e5, gold: 1e5 };
		const p = player({ 'resources.initial': rich, 'resources.baseCapacity': 1e6, 'settlements.outerCost': { food: 0 } });
		const c = await p.start();
		await expect(p.run(T0, 'research.start', { tech: 'economics', settlement: c.id })).rejects.toThrow(/Needs an institute/);
		await p.construct(T0, c.id, inner(c).id, 0, 'institute'); // 60 s
		const t1 = T0 + 60_000;
		const tree = async (now: number, settlement?: string) =>
			(await p.views(now, ['research.tree'], settlement ? { settlement } : {}))['research.tree'] as {
				current: { tech: string } | null;
				all: unknown[];
				speed: number;
				techs: { id: string; level: number; next: { seconds: number; blocked?: string } | null }[];
			};
		expect((await tree(t1)).speed).toBeCloseTo(1.1);
		expect((await tree(t1)).techs.find((t) => t.id === 'economics')?.next?.seconds).toBe(Math.ceil(600 / 1.1));
		await p.run(t1, 'research.start', { tech: 'economics', settlement: c.id });
		await expect(p.run(t1, 'research.start', { tech: 'agriculture', settlement: c.id })).rejects.toThrow(/already researching/);

		// A second settlement with its own institute runs its own queue, but not the same tech.
		let tile = { x: 0, y: 0 };
		for (let i = 0; ; i++) {
			tile = { x: wrap(c.x + 6 + i), y: c.y };
			const free = !(await db
				.prepare('SELECT 1 FROM world_map_tiles WHERE (x = ? OR x = ? OR x = ?) AND y BETWEEN ? AND ?')
				.bind(wrap(tile.x - 1), tile.x, wrap(tile.x + 1), wrap(tile.y - 1), wrap(tile.y + 1))
				.first());
			if (free) break;
		}
		await p.run(t1, 'settlements.found', { from: c.id, kind: 'city', x: tile.x, y: tile.y, name: 'Second' });
		const city = (await p.mine(t1)).find((s) => s.name === 'Second')!;
		const cityInner = (await p.detail(t1, city.id)).districts[0].id;
		await p.construct(t1, city.id, cityInner, 0, 'institute');
		const t2 = t1 + 60_000;
		expect((await tree(t2, city.id)).techs.find((t) => t.id === 'economics')?.next?.blocked).toBe('Being researched in Capital');
		await p.run(t2, 'research.start', { tech: 'agriculture', settlement: city.id });
		expect((await tree(t2)).all).toHaveLength(2);

		const done = await tree(t1 + 700_000);
		expect(done.current).toBeNull();
		expect(done.techs.find((t) => t.id === 'economics')?.level).toBe(1);
	});

	it('accepts tech nodes registered at runtime (opaque discoveries), private or global', async () => {
		const a = player();
		const b = player();
		await a.start();
		await b.start();
		const node = (id: string) => ({
			id,
			name: 'Secret irrigation',
			maxLevel: 3,
			levels: [{ cost: { gold: 100 }, seconds: 60 }],
			percent: { 'resources.productionFactor': 10 },
		});
		const secret = `secret-${a.id.slice(0, 8)}`;
		await a.run(T0, 'research.registerNode', { def: node(secret) }, true);
		await a.run(T0, 'research.setLevel', { tech: secret, level: 2 }, true);
		const techs = async (p: ReturnType<typeof player>) =>
			((await p.views(T0, ['research.tree']))['research.tree'] as { techs: { id: string; level: number }[] }).techs;
		expect((await techs(a)).find((t) => t.id === secret)?.level).toBe(2);
		expect((await techs(b)).find((t) => t.id === secret)).toBeUndefined();
		expect((await a.pool(T0)).factor).toBeCloseTo(1.2);
		expect((await b.pool(T0)).factor).toBe(1);

		const shared = `shared-${a.id.slice(0, 8)}`;
		await a.run(T0, 'research.registerNode', { def: node(shared), global: true }, true);
		expect((await techs(b)).map((t) => t.id)).toContain(shared);
		await expect(a.run(T0, 'research.registerNode', { def: { id: 'Bad Id!', name: 'x', maxLevel: 1, levels: [] } }, true)).rejects.toThrow(
			/id:/,
		);
		await expect(a.run(T0, 'research.registerNode', { def: node('agriculture') }, true)).rejects.toThrow(/already exists/);
	});

	it('lets other plugins change research costs and grant levels', async () => {
		const hero = definePlugin({
			id: 'test-hero',
			version: '0',
			dependsOn: ['research'],
			setup(ctx) {
				ctx.services.get('research').addCostModifier(async () => ({ costFactor: 0.5, timeFactor: 0.5 }));
			},
		});
		const k = createKernel([...plugins, hero]);
		const p = player({}, k);
		const c = await p.start();
		const quote = await k.services.get('research').quote(
			{
				config: engineContext(k, p.id, T0).config,
				db,
				services: k.services,
				memo: (_k: string, l: () => Promise<unknown>) => l(),
			} as never,
			{
				playerId: p.id,
				settlementId: c.id,
				tech: 'economics',
				level: 1,
			},
		);
		expect(quote).toEqual({ cost: { food: 400, wood: 400, stone: 400, gold: 200 }, seconds: 300 });
	});
});

describe('items', () => {
	const forms = async (p: ReturnType<typeof player>, now: number, settlement: string) =>
		(
			(await p.views(now, ['ui.forms'], { placement: 'items', settlement }))['ui.forms'] as {
				command: string;
				fields: { name: string; options?: { value: string }[] }[];
			}[]
		).map((f) => f.command);

	it('appear as forms only while owned, and are consumed atomically with their effect', async () => {
		const p = player({ 'settlements.outerCost': { food: 0 } });
		const c = await p.start();
		expect(await forms(p, T0, c.id)).not.toContain('items.use.land-grant');
		await p.run(T0, 'items.grant', { item: 'land-grant', count: 1 }, true);
		expect(await forms(p, T0, c.id)).toContain('items.use.land-grant');

		// A failed use (inner city is not an outer city) keeps the item.
		await expect(p.run(T0, 'items.use.land-grant', { settlement: c.id, district: inner(c).id })).rejects.toThrow(/only work on outer/);
		const before = outer(c).slots.length;
		await p.run(T0, 'items.use.land-grant', { settlement: c.id, district: outer(c).id });
		expect(outer(await p.detail(T0)).slots).toHaveLength(before + 1);
		expect(await forms(p, T0, c.id)).not.toContain('items.use.land-grant');
		await expect(p.run(T0, 'items.use.land-grant', { settlement: c.id, district: outer(c).id })).rejects.toThrow(/You have no Land grant/);
	});

	it('expansion permits pass the research limit; breakthrough stones raise a cap', async () => {
		const p = player({ 'settlements.outerTechLimit': 1, 'buildings.rules': { farm: { cap: 1 } } });
		const c = await p.start();
		await p.run(T0, 'items.grant', { item: 'expansion-permit', count: 1 }, true);
		const f = (
			(await p.views(T0, ['ui.forms'], { placement: 'items', settlement: c.id }))['ui.forms'] as {
				command: string;
				fields: { name: string; options?: { value: string }[] }[];
			}[]
		).find((x) => x.command === 'items.use.expansion-permit')!;
		const tile = f.fields.find((x) => x.name === 'tile')!.options![0].value;
		await p.run(T0, 'items.use.expansion-permit', { settlement: c.id, tile });
		expect((await p.detail(T0)).districts.filter((d) => d.type === 'outer')).toHaveLength(2);

		await p.construct(T0, c.id, outer(c).id, 0, 'farm');
		await p.run(T0 + 20_000, 'items.grant', { item: 'breakthrough-stone', count: 1 }, true);
		await p.run(T0 + 20_000, 'items.use.breakthrough-stone', { settlement: c.id, target: `${outer(c).id}:0` });
		const cap = outer(await p.detail(T0 + 20_000)).slots[0].current!.cap;
		expect(cap).toBeGreaterThanOrEqual(2);
		expect(cap).toBeLessThanOrEqual(4);
	});
});

describe('troops', () => {
	const garrison = async (p: ReturnType<typeof player>, now: number, settlement?: string) =>
		(await p.views(now, ['troops.garrison'], settlement ? { settlement } : {}))['troops.garrison'] as GarrisonInfo;

	it('trains in batches after the barracks, and garrisons cost upkeep', async () => {
		const p = player();
		const c = await p.start();
		expect((await garrison(p, T0)).trainable.find((u) => u.unit === 'militia')?.blocked).toBe('Requires Barracks 1');
		await p.construct(T0, c.id, inner(c).id, 0, 'barracks'); // 30 s
		await p.run(T0 + 30_000, 'troops.train', { settlement: c.id, unit: 'militia', count: 5 }); // 25 s, 150 food 50 wood
		await expect(p.run(T0 + 30_000, 'troops.train', { settlement: c.id, unit: 'militia', count: 1 })).rejects.toThrow(/Already training/);
		expect((await garrison(p, T0 + 40_000)).training).toMatchObject({ unit: 'militia', count: 5 });

		const g = await garrison(p, T0 + 60_000);
		expect(g.units).toEqual([{ id: 'militia', count: 5 }]);
		expect(g.upkeep.food).toBeCloseTo(0.1);
		const pool = await p.pool(T0 + 60_000);
		expect(pool.upkeep.food).toBeCloseTo(0.1);
		// 500 - 200 (barracks) - 150 (militia) - 0.1/s for the 5 s since they arrived.
		expect(pool.amounts.food).toBeCloseTo(150 - 0.5);
	});

	it('desert when upkeep drains their resource, until upkeep fits the income again', async () => {
		// No income at all: 100 spearmen cost 1 gold/s; 200 gold lasts 200 s.
		const p = player({ 'player-settlements.baseProduction': {}, 'troops.deficitInterval': 100 });
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'spearman', count: 100 }, true);
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'militia', count: 10 }, true); // eats food only
		await p.grant(T0, 'food', 1e6); // plenty of food: only gold runs short
		// Gold runs out at T0 + 200 s: 25% desert, then 25% more every 100 s (gold stays at 0).
		const g = await garrison(p, T0 + 350_000);
		expect(g.units).toEqual(
			expect.arrayContaining([
				{ id: 'spearman', count: 56 }, // 100 -> 75 (at 200 s) -> 56 (at 300 s); the 400 s round is still ahead
				{ id: 'militia', count: 10 },
			]),
		);
		expect((await p.pool(T0 + 350_000)).amounts.gold).toBeCloseTo(0);
		expect((await garrison(p, T0 + 450_000)).units).toContainEqual({ id: 'spearman', count: 42 });
	});

	it('strength counts shortage penalties and plugin modifiers (e.g. a hero commander)', async () => {
		const hero = definePlugin({
			id: 'test-commander',
			version: '0',
			dependsOn: ['troops'],
			setup(ctx) {
				ctx.services.get('troops').addPowerModifier(async () => ({ source: 'Hero: Guan Yu', attack: 1.5 }));
			},
		});
		const p = player({ 'troops.deficitPenalty': { gold: 0.5 } }, createKernel([...plugins, hero]));
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'militia', count: 10 }, true); // atk 50, def 80
		const power = async (now: number) => (await garrison(p, now)).power;
		expect(await power(T0)).toMatchObject({ attack: 75, defense: 80 });
		await p.grant(T0, 'gold', -1000);
		const short = await power(T0);
		expect(short).toMatchObject({ attack: 37.5, defense: 40 });
		expect(short.factors.map((f) => f.source)).toEqual(['gold shortage', 'Hero: Guan Yu']);
	});

	it('cannot be trained where the settlement kind holds no troops', async () => {
		const p = player();
		const c = await p.start();
		for (const r of ['food', 'wood', 'stone']) await p.grant(T0, r, 1000);
		let tile = { x: 0, y: 0 };
		for (let i = 0; ; i++) {
			tile = { x: wrap(c.x + 5 + i), y: c.y };
			if (!(await db.prepare('SELECT 1 FROM world_map_tiles WHERE x = ? AND y = ?').bind(tile.x, tile.y).first())) break;
		}
		await p.run(T0, 'settlements.found', { from: c.id, kind: 'fortress-resource', x: tile.x, y: tile.y, name: 'Mine' });
		const f = (await p.mine(T0)).find((s) => s.name === 'Mine')!;
		const g = await garrison(p, T0, f.id);
		expect(g.allowed).toBe(false);
		await expect(p.run(T0, 'troops.train', { settlement: f.id, unit: 'militia', count: 1 })).rejects.toThrow(/cannot hold troops/);
	});
});

describe('armies', () => {
	const armies = async (p: ReturnType<typeof player>, now: number) => (await p.views(now, ['armies.list']))['armies.list'] as ArmyInfo[];

	it('march out at the pace of the slowest unit and come back home', async () => {
		const p = player({ 'armies.speed': 3600 }); // 1 tile per second for speed-1 units... militia: 12 tiles/s
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'militia', count: 10 }, true);
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'spearman', count: 5 }, true);
		// 36 tiles east, across nothing in particular: spearmen (9 tiles/h * 3600) take 4 s.
		const tile = { x: wrap(c.x + 36), y: c.y };
		await p.run(T0, 'armies.send', { from: c.id, x: tile.x, y: tile.y, units: { militia: 4, spearman: 5 } });
		await expect(p.run(T0, 'armies.send', { from: c.id, x: tile.x, y: tile.y, units: { spearman: 1 } })).rejects.toThrow(
			/Not enough Spearman/,
		);

		const out = (await armies(p, T0 + 1_000))[0];
		expect(out).toMatchObject({ phase: 'outbound', units: { militia: 4, spearman: 5 }, arrivesAt: T0 + 4_000, returnsAt: T0 + 8_000 });
		const there = (await armies(p, T0 + 5_000))[0];
		expect(there.phase).toBe('returning');
		expect(there.report?.outcome).toBe('no-battle');

		expect(await armies(p, T0 + 9_000)).toEqual([]);
		// Persist the return with any command, then the garrison is whole again.
		await p.run(T0 + 9_000, 'timeline.sync', { entity: `army:${out.id}` }, true);
		const g = (await p.views(T0 + 9_000, ['troops.garrison']))['troops.garrison'] as GarrisonInfo;
		expect(g.units).toEqual(
			expect.arrayContaining([
				{ id: 'militia', count: 10 },
				{ id: 'spearman', count: 5 },
			]),
		);
	});
});

describe('pvp', () => {
	it('does not hurt players under beginner protection', async () => {
		const a = player({ 'armies.speed': 1e6 });
		const b = player();
		const ca = await a.start();
		const cb = await b.start();
		await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'spearman', count: 20 }, true);
		await a.run(T0, 'armies.send', { from: ca.id, x: cb.x, y: cb.y, units: { spearman: 20 } });
		const army = ((await a.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const report = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report).toMatchObject({ outcome: 'no-battle', note: 'Under beginner protection' });
		expect((await b.pool(army.arrivesAt)).amounts.food).toBe(500);
	});

	it('attacks another player: garrison battle and looting in one atomic commit', async () => {
		const fast = { 'armies.speed': 1e6, 'pvp.protectionHours': 0 }; // max speed: crossing the world takes well under a second
		const a = player(fast);
		const b = player(fast);
		const ca = await a.start();
		const cb = await b.start();
		await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'spearman', count: 20 }, true); // attack 240, carry 700
		await b.run(T0, 'troops.grant', { settlement: cb.id, unit: 'militia', count: 5 }, true); // defence 40
		await a.run(T0, 'armies.send', { from: ca.id, x: cb.x, y: cb.y, units: { spearman: 20 } });

		// The defender sees it coming (without unit details).
		const incoming = (await b.views(T0, ['armies.incoming']))['armies.incoming'] as { settlement: string }[];
		expect(incoming).toEqual([expect.objectContaining({ settlement: cb.id })]);

		// Process the arrival (as the sweep would) and look at the result.
		const army = ((await a.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const report = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report).toMatchObject({ outcome: 'victory', attack: 240, defense: 40, target: { kind: 'capital' } });
		expect(report.losses.defender).toEqual({ militia: 5 });
		const taken = Object.values(report.loot).reduce((x, y) => x + y, 0);
		expect(taken).toBeGreaterThan(0);
		expect(taken).toBeLessThanOrEqual(700);

		// Loot takes at most half of what exceeds the protected amount (no warehouse here: all of it).
		expect(report.loot.food ?? 0).toBeLessThanOrEqual(250);
		// The defender really lost troops and resources.
		const defenses = (await b.views(army.arrivesAt, ['pvp.defenses']))['pvp.defenses'] as { report: { outcome: string } }[];
		expect(defenses).toHaveLength(1);
		expect(defenses[0].report.outcome).toBe('victory'); // the attacker's victory, from the defender's log
		const g = (await b.views(army.arrivesAt, ['troops.garrison']))['troops.garrison'] as GarrisonInfo;
		expect(g.units).toEqual([]);
		expect((await b.pool(army.arrivesAt)).amounts.food).toBeLessThan(500);
	});
});

describe('NPC settlements', () => {
	it('counts attack modifiers such as a hero leading the army', async () => {
		const hero = definePlugin({
			id: 'test-general',
			version: '0',
			dependsOn: ['armies'],
			setup(ctx) {
				ctx.services.get('armies').addAttackModifier(async () => ({ source: 'Hero: Zhang Fei', factor: 2 }));
			},
		});
		const p = player(
			{ 'armies.speed': 1e6, 'npc-camps.defenders': { 'npc-outpost': { defense: 300, units: {} } } },
			createKernel([...plugins, hero]),
		);
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'spearman', count: 20 }, true); // 240 alone would lose to 300
		const at = { x: wrap(c.x + 5), y: c.y };
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...at }, true);
		await p.run(T0, 'armies.send', { from: c.id, ...at, units: { spearman: 20 } });
		const report = ((await p.views(T0 + 1_500, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report).toMatchObject({ outcome: 'victory', attack: 480, attackFactors: [{ source: 'Hero: Zhang Fei', factor: 2 }] });
	});

	it('can be raided: outposts give food, fortresses give troops, strong defence wins', async () => {
		const p = player({
			'armies.speed': 1e6,
			'npc-camps.defenders': { 'npc-outpost': { defense: 100, units: {} }, 'npc-fortress': { defense: 1e6, units: { militia: 40 } } },
		});
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'spearman', count: 20 }, true); // attack 240, carry 700
		// Place an outpost and a fortress right next to the capital's ring.
		const place = async (kind: string, dx: number) => {
			await p.run(T0, 'npc-camps.spawnAt', { kind, x: wrap(c.x + dx), y: c.y }, true);
			return { x: wrap(c.x + dx), y: c.y };
		};
		const outpost = await place('npc-outpost', 5);
		const fortress = await place('npc-fortress', 7);

		await p.run(T0, 'armies.send', { from: c.id, x: outpost.x, y: outpost.y, units: { spearman: 10 } });
		await p.run(T0, 'armies.send', { from: c.id, x: fortress.x, y: fortress.y, units: { spearman: 10 } });
		// Each leg takes 1 s at this speed: look while they are on the way back.
		const list = (await p.views(T0 + 1_500, ['armies.list']))['armies.list'] as ArmyInfo[];
		const raid = list.find((a) => a.target.x === outpost.x)!;
		expect(raid.report).toMatchObject({ outcome: 'victory', target: { kind: 'npc-outpost' } });
		expect(raid.loot.food).toBeGreaterThan(0); // the outpost's starting food, up to what survivors carry
		const siege = list.find((a) => a.target.x === fortress.x)!;
		expect(siege.report?.outcome).toBe('defeat');
		expect(siege.units.spearman).toBeLessThan(10);
	});

	it('are registered by their own plugin and spawned by the GM onto free land', async () => {
		const gm = player();
		await gm.run(T0, 'npc-camps.spawn', { kind: 'npc-outpost', count: 3 }, true);
		await expect(gm.run(T0, 'npc-camps.spawn', { kind: 'npc-outpost', count: 1 })).rejects.toThrow(/Unknown command/);
		const { results } = await db
			.prepare(
				"SELECT s.owner_id, s.x, s.y, (SELECT COUNT(*) FROM world_map_tiles t WHERE t.entity = 'settlement:' || s.id) AS tiles FROM settlements_settlements s WHERE kind = 'npc-outpost' AND created_at = ?",
			)
			.bind(T0)
			.all<{ owner_id: string | null; tiles: number }>();
		expect(results.length).toBeGreaterThanOrEqual(3);
		expect(results.every((r) => r.owner_id === null && r.tiles === 1)).toBe(true);
	});
});

describe('concurrency', () => {
	it('never double-spends when the same player sends commands in parallel', async () => {
		const p = player({ 'resources.initial': { food: 40, wood: 60 } }); // exactly one farm
		const c = await p.start();
		const results = await Promise.allSettled(Array.from({ length: 4 }, (_, i) => p.construct(T0, c.id, outer(c).id, i % 3, 'farm')));
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect((await p.pool(T0)).amounts).toMatchObject({ food: 0, wood: 0 });
	});
});

describe('GM-tunable rules', () => {
	it('apply immediately, including to unsettled offline time', async () => {
		const p = player({ 'buildings.productionMultiplier': 3 });
		const c = await p.start();
		await p.construct(T0, c.id, outer(c).id, 0, 'farm');
		expect((await p.pool(T0 + 20_000)).amounts.food).toBeCloseTo(460 + 30);
	});

	it('respect a lowered offline cap', async () => {
		const p = player({ 'engine.maxOfflineSeconds': 60 });
		const c = await p.start();
		await p.construct(T0, c.id, outer(c).id, 0, 'farm');
		expect((await p.pool(T0 + 3600_000)).amounts.food).toBeCloseTo(460 + 60);
	});
});
