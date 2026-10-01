/**
 * Game rules through the engine against a real (local) D1, with a fake clock.
 * Each test uses fresh players (and capitals at random map spots), so tests never share rows.
 */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	computeViews,
	createKernel,
	definePlugin,
	engineContext,
	executeCommand,
	GameError,
	resolveConfig,
	type Kernel,
} from '../src/kernel';
import { plugins } from '../src/plugins';
import { wrap } from '../src/plugins/world-map';
import type {
	ArmyInfo,
	BattleFormationInfo,
	GarrisonInfo,
	HeroCandidates,
	HeroInfo,
	MapTile,
	ResearchTree,
	ResolvedForm,
	ResourcePool,
	SettlementDetail,
	SettlementSummary,
	TerrainWindow,
	UnitNumbers,
	FormationWidgetData,
	HeroPost,
	MailInbox,
	NearbyOverview,
} from '../src/shared/api';

const db = env.DB;
const T0 = 2_000_000_000_000;
const defaultKernel = createKernel(plugins);
const NO_TERRAIN_BONUS = Object.fromEntries(
	defaultKernel.services
		.get('terrain')
		.list()
		.map((t) => [t.id, {}]),
);

/**
 * Simple fixed-number units, so battle and march tests do not depend on the starter army's
 * formulas (tested on their own): militia needs a barracks, spearmen a level-2 one.
 */
const testUnits = definePlugin({
	id: 'test-units',
	version: '0',
	dependsOn: ['troops', 'buildings'],
	setup(ctx) {
		const troops = ctx.services.get('troops');
		const buildings = ctx.services.get('buildings');
		troops.define({
			id: 'militia',
			name: 'Militia',
			stats: { attack: 5, defense: 8, hp: 10, speed: 12, carry: 20, cost: { food: 30, wood: 10 }, seconds: 5, upkeep: { food: 0.02 } },
		});
		troops.define({
			id: 'spearman',
			name: 'Spearman',
			stats: {
				attack: 12,
				defense: 15,
				hp: 20,
				speed: 9,
				carry: 35,
				cost: { food: 50, wood: 40, stone: 20, gold: 10 },
				seconds: 12,
				upkeep: { food: 0.04, gold: 0.01 },
			},
		});
		const need: Record<string, number> = { militia: 1, spearman: 2 };
		troops.addTrainingGate(async (api, s, unit) =>
			!need[unit.id] || (await buildings.level(api, s.id, 'barracks')) >= need[unit.id] ? null : `Requires Barracks ${need[unit.id]}`,
		);
	},
});
const unitsKernel = createKernel([...plugins, testUnits]);

function player(extra?: Record<string, unknown>, kernel: Kernel = defaultKernel) {
	// No built-in income, no terrain bonus and full planning-table costs, so the numbers come only from buildings.
	const overrides = {
		'starter-content.baseProduction': {},
		'terrain.bonus': NO_TERRAIN_BONUS,
		'buildings.ownResourceFreeUntil': 0,
		...extra,
	};
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
const inbox = async (p: ReturnType<typeof player>, now: number) => (await p.views(now, ['mail.inbox']))['mail.inbox'] as MailInbox;
const outer = (d: SettlementDetail, i = 0) => d.districts.filter((x) => x.type === 'outer')[i];

describe('capital', () => {
	it('is founded with an inner city, one outer city and the starting resources', async () => {
		const p = player();
		const capital = await p.start();
		expect(capital.kind).toBe('capital');
		expect(capital.districts.map((d) => d.type)).toEqual(['inner', 'outer']);
		// 12 slots, plus one holding the level-1 wall every settlement starts with.
		expect(inner(capital).slots).toHaveLength(13);
		expect(inner(capital).slots[12].current).toMatchObject({ building: 'wall', level: 1 });
		expect(outer(capital).slots.length).toBeGreaterThanOrEqual(3);
		expect(outer(capital).slots.length).toBeLessThanOrEqual(6);
		expect((await p.pool(T0)).amounts).toEqual({ food: 500, wood: 500, stone: 500, metal: 200, gold: 200 });
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
		expect(warehouse?.effects).toEqual({ produces: {}, stats: { 'resources.capacity': 2000 } });
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

	it('allows one counting house per outer city (unique per district), even while one is being built', async () => {
		const p = player();
		const c = await p.start();
		await p.construct(T0, c.id, outer(c).id, 0, 'gold-mine');
		await expect(p.construct(T0, c.id, outer(c).id, 1, 'gold-mine')).rejects.toThrow(/Only one Counting House per district/);
		await p.construct(T0, c.id, outer(c).id, 1, 'ironworks');
		const pool = await p.pool(T0);
		expect(Object.keys(pool.amounts).sort()).toEqual(['food', 'gold', 'metal', 'stone', 'wood']);
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

	it('resource buildings cost none of their own resource up to level 3 (GM-tunable)', async () => {
		const buildings = defaultKernel.services.get('buildings');
		const api = (over: Record<string, unknown>) => ({ config: engineContext(defaultKernel, 'x', 0, over).config }) as never;
		expect(buildings.levelCost(api({}), 'lumber-mill', 1).cost).toEqual({ stone: 40 });
		expect(buildings.levelCost(api({}), 'farm', 3).cost).toEqual({ wood: 170 });
		expect(buildings.levelCost(api({}), 'lumber-mill', 4).cost).toEqual({ stone: 200, wood: 280 });
		expect(buildings.levelCost(api({ 'buildings.ownResourceFreeUntil': 1 }), 'farm', 2).cost).toEqual({ wood: 100, food: 70 });

		// Building one really charges no wood.
		const p = player({ 'buildings.ownResourceFreeUntil': 3 });
		const c = await p.start();
		await p.construct(T0, c.id, outer(c).id, 0, 'lumber-mill');
		expect((await p.pool(T0)).amounts).toMatchObject({ wood: 500, stone: 460 });
	});

	it('lets planning tables leave out higher levels: they grow from the nearest lower row', async () => {
		const row = (food: number, seconds: number) => ({ cost: { food }, seconds });
		const levels = [row(1, 1), row(2, 2), row(3, 3), row(4, 4), row(5, 5), row(6, 6), row(100, 70), null, null, row(1000, 700)];
		const p = player({ 'buildings.rules': { farm: { levels, costGrowth: 2, timeGrowth: 2 } } });
		await p.start();
		const svc = defaultKernel.services.get('buildings');
		const api = {
			...engineContext(defaultKernel, p.id, T0, { 'buildings.rules': { farm: { levels, costGrowth: 2, timeGrowth: 2 } } }),
			db,
		} as never;
		expect(svc.levelCost(api, 'farm', 9)).toEqual({ cost: { food: 400 }, seconds: 280 }); // level 7 x 2^2
		expect(svc.levelCost(api, 'farm', 10)).toEqual({ cost: { food: 1000 }, seconds: 700 }); // given in the table
		expect(svc.levelCost(api, 'farm', 11)).toEqual({ cost: { food: 2000 }, seconds: 1400 });
		// Levels 1-7 are required.
		const holey = player({ 'buildings.rules': { farm: { levels: [row(1, 1), null, row(3, 3)] } } });
		await holey.start();
		expect((await holey.pool(T0)).amounts.food).toBe(500); // the invalid override is ignored: defaults apply
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
		const c = await p.start(); // 200 gold at -2/s: zero at T0 + 100 s, the -10 floor at T0 + 105 s
		const due = await db
			.prepare("SELECT due_at FROM timeline_events WHERE entity = ? AND type = 'resources.depleted'")
			.bind(`settlement:${c.id}`)
			.first<{ due_at: number }>();
		expect(due?.due_at).toBe(T0 + 105_000);
		// Due events are processed when the settlement's state is next used, e.g. by building something.
		await p.construct(T0 + 150_000, c.id, outer(c).id, 0, 'farm');
		expect(seen).toContainEqual({ resource: 'gold', at: T0 + 105_000 });
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
		const p = player({ 'starter-content.baseProduction': { capital: { wood: 1 } } });
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
		const p = player({ 'player-settlements.outerCost': { food: 0 } });
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
		await p.grant(T0, 'wood', 3000);
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
		await p.run(T0, 'settlements.found', { kind: 'fortress-resource', x: tile.x, y: tile.y, name: 'Edge' }, true);
		const fortress = (await p.mine(T0)).find((s) => s.name === 'Edge')!;
		expect(fortress).toMatchObject({ kind: 'fortress-resource', x: 512, y: tile.y, outer: 0 });

		const window = (await p.views(T0, ['settlements.map'], { x: '-511', y: String(tile.y), r: '1' }))['settlements.map'] as MapTile[];
		expect(window).toContainEqual(expect.objectContaining({ x: 512, y: tile.y, name: 'Edge', centre: true }));

		const f = await p.detail(T0, fortress.id);
		await expect(p.construct(T0, f.id, f.districts[0].id, 0, 'palace')).rejects.toThrow(GameError);
		await p.construct(T0, f.id, f.districts[0].id, 0, 'farm');
		await expect(p.run(T0, 'settlements.found', { kind: 'fortress-resource', x: tile.x, y: tile.y }, true)).rejects.toThrow(
			/already occupied/,
		);
	});
});

describe('terrain', () => {
	it('gives the district on it a production bonus; painting it settles first', async () => {
		const p = player({ 'terrain.bonus': {} }); // the real bonuses
		const c = await p.start();
		const o = outer(c);
		await p.construct(T0, c.id, o.id, 0, 'lumber-mill'); // 10 s; 440 wood left
		// Grassland (the default) does nothing for wood: 1/s.
		expect((await p.pool(T0 + 20_000)).amounts.wood).toBeCloseTo(450);
		await p.run(T0 + 20_000, 'terrain.paint', { x: o.x, y: o.y, width: 1, height: 1, terrain: 'forest' }, true);
		const pool = await p.pool(T0 + 30_000);
		expect(pool.extra.wood).toBeCloseTo(0.3); // forest: +30% wood
		expect(pool.amounts.wood).toBeCloseTo(450 + 13);
		// The map view shows it, and candidate tiles name their terrain.
		const w = (await p.views(T0 + 30_000, ['terrain.window'], { x: String(o.x), y: String(o.y), radius: '1' }))[
			'terrain.window'
		] as TerrainWindow;
		expect(w.rows[1][1]).toBe('f');
		const forms = (await p.views(T0 + 30_000, ['ui.forms'], { placement: 'settlement', settlement: c.id }))['ui.forms'] as ResolvedForm[];
		const where = forms.find((f) => f.command === 'settlements.addOuter')!.fields.find((f) => f.name === 'tile')!;
		expect(where.options![0].label).toMatch(/^\(-?\d+, -?\d+\) · \S/);
	});

	it('lets a fog plugin hide tiles; imports whole chunks and reports the shares', async () => {
		const fog = definePlugin({
			id: 'test-fog',
			version: '0',
			dependsOn: ['terrain'],
			setup(ctx) {
				ctx.services
					.get('terrain')
					.addVisibility(async (_api, _player, tiles) => new Set(tiles.filter((t) => t.x % 2 === 0).map((t) => `${t.x},${t.y}`)));
			},
		});
		const p = player({}, createKernel([...plugins, fog]));
		await p.start();
		const w = (await p.views(T0, ['terrain.window'], { x: '0', y: '0', radius: '1' }))['terrain.window'] as TerrainWindow;
		expect(w.rows[1]).toBe('?g?'); // x = -1 and 1 are hidden

		const gm = player();
		await expect(gm.run(T0, 'terrain.importChunks', { chunks: [{ cx: 31, cy: 31, data: 'x'.repeat(1024) }] }, true)).rejects.toThrow(
			/Unknown terrain code/,
		);
		await gm.run(T0, 'terrain.importChunks', { chunks: [{ cx: 31, cy: 31, data: 'v'.repeat(1024) }] }, true);
		const kernel = defaultKernel;
		const report = kernel.reports.get('terrain.shares')!;
		const rows = await report.run(
			{ ...engineContext(kernel, gm.id, T0), db, services: kernel.services, memo: (_k: string, l: () => Promise<unknown>) => l() } as never,
			{},
		);
		expect(rows.find((r) => r.terrain === 'Ore vein')!.tiles).toBeGreaterThanOrEqual(1024);
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
		expect(farm.options[0].blocked).toBe('Requires Agriculture Lv 1');
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
		const p = player({ 'resources.initial': rich, 'resources.baseCapacity': 1e6, 'player-settlements.outerCost': { food: 0 } });
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
		// Busy here, but nothing is missing: the tree (shared by all settlements) shows it as open.
		const agriculture = (await tree(t1)).techs.find((t) => t.id === 'agriculture')!.next as { blocked?: string; locked?: string };
		expect(agriculture).toMatchObject({ blocked: 'This settlement is already researching' });
		expect(agriculture.locked).toBeUndefined();

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
		await p.run(t1, 'settlements.found', { kind: 'city', x: tile.x, y: tile.y, name: 'Second' }, true);
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
				...engineContext(k, p.id, T0),
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
		const p = player({ 'player-settlements.outerCost': { food: 0 } });
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
		const p = player(undefined, unitsKernel);
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

	it('rout in rounds when upkeep drains their resource, balanced after the last round', async () => {
		// No income: 100 spearmen cost 1 gold/s; 200 gold lasts 200 s. 4 rounds, 100 s apart.
		const p = player({ 'starter-content.baseProduction': {}, 'troops.shortageRounds': 4, 'troops.shortageInterval': 100 }, unitsKernel);
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'spearman', count: 100 }, true);
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'militia', count: 10 }, true); // eats food only
		await p.grant(T0, 'food', 800); // enough food: only gold runs short
		// Each round cuts deficit / rounds left: 1/4, then 0.75/3, 0.5/2, 0.25/1 gold/s = 25 spearmen each.
		const count = async (now: number, unit: string) => (await garrison(p, now)).units.find((u) => u.id === unit)?.count ?? 0;
		expect(await count(T0 + 250_000, 'spearman')).toBe(75);
		expect(await count(T0 + 350_000, 'spearman')).toBe(50);
		expect(await count(T0 + 350_000, 'militia')).toBe(10);
		expect(await count(T0 + 550_000, 'spearman')).toBe(0);
		expect((await p.pool(T0 + 550_000)).rates.gold ?? 0).toBeCloseTo(0);

		// Each round is a notice in the mailbox, once the rounds are really processed (views drop their writes).
		expect((await inbox(p, T0 + 550_000)).messages).toEqual([]);
		await p.run(T0 + 550_000, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		const notices = (await inbox(p, T0 + 550_000)).messages;
		expect(notices).toHaveLength(4);
		expect(notices[0]).toMatchObject({
			kind: 'war-reports.shortage',
			title: 'Troops deserted {settlement}: out of {resource}',
			vars: { resource: 'Currency' },
			data: { resource: 'gold', routed: { spearman: 25 } },
		});
	});

	it('drop a tier (highest first) when short of their special upkeep; the lowest tier routs', async () => {
		const p = player({
			'starter-content.baseProduction': {},
			'resources.baseCapacity': 1e9,
			'troops.shortageRounds': 2,
			'troops.shortageInterval': 1e6,
			'engine.maxOfflineSeconds': 2e6,
		});
		const c = await p.start();
		for (const r of ['food', 'gold']) await p.grant(T0, r, 1e7);
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-3', count: 100 }, true);
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 50 }, true);
		// 200 metal at ~48 metal/h runs out after ~4.1 h. Round 1 cuts half the deficit by
		// moving tier-3 infantry down to tier 2 (each saves ~0.25 metal/h); tier 1 is untouched.
		const units = async (now: number) => Object.fromEntries((await garrison(p, now)).units.map((u) => [u.id, u.count]));
		const after1 = await units(T0 + 20_000_000);
		expect(after1['infantry-3']).toBeLessThanOrEqual(3);
		expect(after1['infantry-2']).toBeGreaterThanOrEqual(97);
		expect(after1['infantry-1']).toBe(50);
		// Round 2 (the last) takes the rest: with no metal income at all, no infantry can stay.
		expect(await units(T0 + 1_100_000_000)).toEqual({});
	});

	it('cannot be trained where the settlement kind holds no troops', async () => {
		const p = player(undefined, unitsKernel);
		const c = await p.start();
		for (const r of ['food', 'wood', 'stone']) await p.grant(T0, r, 1000);
		let tile = { x: 0, y: 0 };
		for (let i = 0; ; i++) {
			tile = { x: wrap(c.x + 5 + i), y: c.y };
			if (!(await db.prepare('SELECT 1 FROM world_map_tiles WHERE x = ? AND y = ?').bind(tile.x, tile.y).first())) break;
		}
		await p.run(T0, 'settlements.found', { kind: 'fortress-resource', x: tile.x, y: tile.y, name: 'Mine' }, true);
		const f = (await p.mine(T0)).find((s) => s.name === 'Mine')!;
		const g = await garrison(p, T0, f.id);
		expect(g.allowed).toBe(false);
		await expect(p.run(T0, 'troops.train', { settlement: f.id, unit: 'militia', count: 1 })).rejects.toThrow(/cannot hold troops/);
	});
});

describe('starter army', () => {
	const units = async (p: ReturnType<typeof player>, now = T0) =>
		new Map(((await p.views(now, ['troops.units']))['troops.units'] as UnitNumbers[]).map((u) => [u.id, u]));

	it('computes attributes, speed, carry, cost, time and upkeep from the tunable formulas', async () => {
		const p = player();
		await p.start();
		const u = await units(p);
		expect(u.get('infantry-1')).toMatchObject({ attack: 10, defense: 10, seconds: 10 });
		expect(u.get('infantry-1')!.hp).toBeCloseTo(11.5);
		expect(u.get('archer-2')!.defense).toBeCloseTo(27.6);
		expect(u.get('cavalry-3')!.attack).toBeCloseTo(96.6);
		expect(u.get('cavalry-6')!.defense).toBeCloseTo(781.25);
		// Speed: the whole 1024-tile map in 36 hours; cavalry 15% faster at tier 1, then x1.5 per tier.
		expect(u.get('archer-6')!.speed).toBeCloseTo(120);
		expect(u.get('cavalry-2')!.speed).toBeCloseTo(120 * 1.725);
		expect(u.get('cavalry-4')!.carry).toBe(100);
		// Training cost: 100 x r^1.2 split by family; the family's own resource takes 40%.
		expect(u.get('infantry-1')!.cost).toEqual({ food: 15, wood: 15, metal: 40, stone: 5, gold: 25 });
		expect(u.get('archer-1')!.cost.wood).toBe(40);
		const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
		expect(total(u.get('cavalry-4')!.cost)).toBeGreaterThan(3340);
		expect(total(u.get('cavalry-4')!.cost)).toBeLessThan(3360);
		// Upkeep per hour: 1 x r^0.8, infantry 60% food / 10% metal / 30% currency.
		expect(u.get('infantry-1')!.upkeep.food * 3600).toBeCloseTo(0.6);
		expect(u.get('infantry-1')!.upkeep.metal * 3600).toBeCloseTo(0.1);
		expect(u.get('cavalry-1')!.upkeep.metal).toBeUndefined();

		const tuned = player({ 'starter-army.attributes': { base: 20 } });
		await tuned.start();
		expect((await units(tuned)).get('infantry-1')!.attack).toBe(20);
	});

	it('trains tiers 1-4 by barracks level; tiers 5-6 never', async () => {
		const p = player({ 'buildings.speed': 1e6 });
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'barracks');
		const trainable = async (now: number) => ((await p.views(now, ['troops.garrison']))['troops.garrison'] as GarrisonInfo).trainable;
		const t = await trainable(T0 + 1_000);
		expect(t.find((x) => x.unit === 'infantry-1')?.blocked).toBeUndefined();
		expect(t.find((x) => x.unit === 'infantry-2')?.blocked).toBe('Requires Infantry Camp Lv 5');
		expect(t.find((x) => x.unit === 'archer-1')?.blocked).toBe('Requires Archer Camp Lv 1');
		expect(t.some((x) => x.unit === 'infantry-5')).toBe(false);
		await expect(p.run(T0 + 1_000, 'troops.train', { settlement: c.id, unit: 'cavalry-5', count: 1 })).rejects.toThrow(/cannot be trained/);

		// The training form lives in the entry of the barracks that trains them.
		const trainForm = async (type: string) =>
			((await p.views(T0 + 1_000, ['ui.forms'], { placement: 'building', settlement: c.id, type }))['ui.forms'] as ResolvedForm[]).find(
				(f) => f.command === 'troops.train',
			);
		const options = (await trainForm('barracks'))!.fields.find((f) => f.name === 'unit')!.options!.map((o) => o.value);
		expect(options).toEqual(['infantry-1']);
		expect(await trainForm('archer-camp')).toBeUndefined(); // not built: nothing trainable
		expect(await trainForm('warehouse')).toBeUndefined();

		await p.run(T0 + 1_000, 'troops.train', { settlement: c.id, unit: 'infantry-1', count: 2 });
		const overview = (await p.views(T0 + 1_000, ['troops.overview']))['troops.overview'] as GarrisonInfo[];
		expect(overview).toEqual([
			expect.objectContaining({ settlement: c.id, training: expect.objectContaining({ unit: 'infantry-1', count: 2 }) }),
		]);
	});

	it('trains faster in higher barracks: -5 points per level to 10, then x0.95 per level', async () => {
		const p = player({ 'buildings.speed': 1e6 });
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'barracks');
		const at = T0 + 1_000;
		const base = ((await p.views(at, ['troops.units']))['troops.units'] as UnitNumbers[]).find((u) => u.id === 'infantry-3')!.seconds;
		const seconds = async (level: number) => {
			await p.run(at, 'buildings.setLevel', { settlement: c.id, district: inner(c).id, slot: 0, level }, true);
			const g = (await p.views(at, ['troops.garrison']))['troops.garrison'] as GarrisonInfo;
			return g.trainable.find((x) => x.unit === 'infantry-3')!.seconds;
		};
		expect(await seconds(10)).toBe(Math.ceil(base * 0.55));
		expect(await seconds(12)).toBe(Math.ceil(base * 0.55 * 0.95 ** 2));
	});

	it('lets another plugin require (and use up) something per unit, e.g. training quota', async () => {
		// Stand-in for an item plugin's "training quota": 1 currency per unit above tier 1.
		const quota = definePlugin({
			id: 'test-quota',
			version: '0',
			dependsOn: ['troops', 'resources', 'settlements'],
			setup(ctx) {
				const resources = ctx.services.get('resources');
				const settlements = ctx.services.get('settlements');
				ctx.services.get('troops').addTrainingRequirement({
					async check(api, s, unit, count) {
						if ((unit.tier ?? 1) < 2) return null;
						return ((await resources.amounts(api, settlements.entity(s.id))).gold ?? 0) >= count + 1000 ? null : 'Needs training quota';
					},
					consume: async (api, s, unit, count) => {
						if ((unit.tier ?? 1) >= 2) await resources.spend(api, settlements.entity(s.id), { gold: count });
					},
				});
			},
		});
		const p = player({ 'buildings.speed': 1e6 }, createKernel([...plugins, quota]));
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'barracks');
		const at = T0 + 1_000;
		await p.run(at, 'buildings.setLevel', { settlement: c.id, district: inner(c).id, slot: 0, level: 5 }, true);
		for (const r of ['food', 'wood', 'metal', 'stone']) await p.grant(at, r, 10_000);
		await expect(p.run(at, 'troops.train', { settlement: c.id, unit: 'infantry-2', count: 2 })).rejects.toThrow(/Needs training quota/);
		await p.grant(at, 'gold', 2_000);
		const before = (await p.pool(at)).amounts.gold;
		await p.run(at, 'troops.train', { settlement: c.id, unit: 'infantry-2', count: 2 });
		const unitCost = ((await p.views(at, ['troops.units']))['troops.units'] as UnitNumbers[]).find((u) => u.id === 'infantry-2')!.cost.gold;
		expect((await p.pool(at)).amounts.gold).toBeCloseTo(before - 2 * unitCost - 2);
	});
});

describe('armies', () => {
	const armies = async (p: ReturnType<typeof player>, now: number) => (await p.views(now, ['armies.list']))['armies.list'] as ArmyInfo[];

	it('march out at the pace of the slowest unit and come back home', async () => {
		const p = player({ 'armies.speed': 3600, 'armies.minSeconds': 0 }, unitsKernel); // 1 tile per second for speed-1 units... militia: 12 tiles/s
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

describe('march upkeep', () => {
	const armies = async (p: ReturnType<typeof player>, now: number) => (await p.views(now, ['armies.list']))['armies.list'] as ArmyInfo[];

	it('takes at least 3 minutes each way and prepays the round trip; a recall refunds the unused part', async () => {
		// Spearmen walk 9 tiles/h; x100 makes the 3-tile trip 12 s, so the 180 s minimum applies.
		const p = player({ 'starter-content.baseProduction': {}, 'armies.speed': 100 }, unitsKernel);
		const c = await p.start();
		// 100 spearmen: 1 gold/s of upkeep at home. A neighbouring tile is seconds away: 180 s minimum.
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'spearman', count: 100 }, true);
		const tile = { x: wrap(c.x + 3), y: c.y };
		await expect(p.run(T0, 'armies.send', { from: c.id, ...tile, units: { spearman: 100 } })).rejects.toThrow(/Not enough/); // 360 gold > 200
		await p.grant(T0, 'gold', 300); // 500
		await p.grant(T0, 'food', 1000); // 1500 >= 1440
		await p.run(T0, 'armies.send', { from: c.id, ...tile, units: { spearman: 100 } });
		const out = (await armies(p, T0))[0];
		expect(out.arrivesAt).toBe(T0 + 180_000);
		expect(out.provisions.gold).toBeCloseTo(360);
		expect(out.provisions.food).toBeCloseTo(4 * 360);
		expect((await p.pool(T0)).amounts.gold).toBeCloseTo(140);
		// Away from home they cost nothing there.
		expect((await p.pool(T0)).upkeep.gold ?? 0).toBe(0);

		// Recalled after 60 s: back at 120 s, having used 120 of the 360 s paid for. The rest
		// travels back with the army and is stored only when it gets home.
		await p.run(T0 + 60_000, 'armies.recall', { id: out.id });
		const back = (await armies(p, T0 + 60_000))[0];
		expect(back).toMatchObject({ phase: 'returning', returnsAt: T0 + 120_000 });
		expect(back.loot.gold).toBeCloseTo(240);
		expect((await p.pool(T0 + 60_000)).amounts.gold).toBeCloseTo(140);
		await expect(p.run(T0 + 61_000, 'armies.recall', { id: out.id })).rejects.toThrow(/already on its way back/);
		expect(await armies(p, T0 + 121_000)).toEqual([]);
		// The return is the army's own event: processed by the cron sweep, here by hand.
		await p.run(T0 + 121_000, 'timeline.sync', { entity: `army:${out.id}` }, true);
		// Home again, their upkeep (1 gold/s) runs from when the return is processed.
		expect((await p.pool(T0 + 131_000)).amounts.gold).toBeCloseTo(140 + 240 - 10);
	});
});

describe('map overview', () => {
	it('lists the settlements around a point, nearest first, within a radius, NPCs only on request', async () => {
		const p = player();
		const c = await p.start();
		const near = { x: wrap(c.x + 4), y: c.y }; // 4 tiles
		const diagonal = { x: wrap(c.x + 3), y: wrap(c.y + 4) }; // 5 tiles
		const far = { x: wrap(c.x + 30), y: c.y };
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-fortress', ...diagonal }, true);
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...near }, true);
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...far }, true);
		// Someone else's fortress next door, and our own one (never listed).
		const q = player();
		await q.start();
		await q.run(T0, 'settlements.found', { kind: 'fortress-military', x: wrap(c.x - 4), y: c.y, name: 'Neighbour' }, true);
		await p.run(T0, 'settlements.found', { kind: 'fortress-military', x: c.x, y: wrap(c.y - 4), name: 'Mine' }, true);

		const nearby = async (params: Record<string, string>) =>
			((await p.views(T0, ['settlements.nearby'], params))['settlements.nearby'] as NearbyOverview).settlements.filter(
				(s) => [near, diagonal, far].some((t) => t.x === s.x && t.y === s.y) || ['Neighbour', 'Mine'].includes(s.name),
			);
		const around = await nearby({ r: '10' });
		expect(around.map((s) => s.distance)).toEqual([4, 4, 5]);
		expect(around.slice(0, 2).map((s) => s.kind)).toEqual(expect.arrayContaining(['npc-outpost', 'fortress-military']));
		expect(around[2].kind).toBe('npc-fortress');
		expect(around.find((s) => s.kind === 'fortress-military')).toMatchObject({
			name: 'Neighbour',
			npc: false,
			ownerName: null, // engine tests have no accounts, so no names
		});
		expect((await nearby({ r: '10', npc: '1' })).map((s) => s.kind)).toEqual(['npc-outpost', 'npc-fortress']);
		expect((await nearby({ r: '50', npc: '1' })).map((s) => s.distance)).toEqual([4, 5, 30]);
		// Around another point, e.g. where the map is looking.
		expect((await nearby({ x: String(far.x), y: String(far.y), r: '1', npc: '1' })).map((s) => s.distance)).toEqual([0]);

		// The GM caps the radius (settlements.nearbyRadius): larger requests are cut to it.
		const capped = player({ 'settlements.nearbyRadius': 6 });
		const overview = (await capped.views(T0, ['settlements.nearby'], { x: String(c.x), y: String(c.y), r: '50', npc: '1' }))[
			'settlements.nearby'
		] as NearbyOverview;
		expect(overview.maxRadius).toBe(6);
		expect(overview.settlements.every((s) => s.distance <= 6)).toBe(true);
		expect(overview.settlements.some((s) => s.x === far.x && s.y === far.y)).toBe(false);
	});
});

describe('mailbox', () => {
	it('gets the report once the arrival is committed: armies.sync does it at once, without waiting for the sweep', async () => {
		const p = player({ 'armies.speed': 1e6, 'armies.minSeconds': 0 }, unitsKernel);
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'militia', count: 2 }, true);
		await p.run(T0, 'armies.send', { from: c.id, x: wrap(c.x + 20), y: c.y, units: { militia: 2 } });
		const at = T0 + 1_500; // there after 1 s, home after 2 s
		// Views show the arrival in passing (their writes are dropped): the report, but no mail yet.
		expect(((await p.views(at, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report).not.toBeNull();
		expect((await inbox(p, at)).messages).toEqual([]);
		await p.run(at, 'armies.sync');
		expect((await inbox(p, at)).messages).toEqual([expect.objectContaining({ kind: 'war-reports.march' })]);
		await p.run(at, 'armies.sync'); // nothing more is due: no duplicate
		expect((await inbox(p, at)).messages).toHaveLength(1);
	});

	it('collects reports; read, delete, and keep only the newest `mail.keep`', async () => {
		const p = player({ 'armies.speed': 1e6, 'armies.minSeconds': 0, 'mail.keep': 2 }, unitsKernel);
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'militia', count: 3 }, true);
		// Three scouting trips to empty land, one after the other.
		for (let i = 0; i < 3; i++) {
			const t = T0 + i * 10_000;
			await p.run(t, 'armies.send', { from: c.id, x: wrap(c.x + 20 + i), y: c.y, units: { militia: 1 } });
			const army = ((await p.views(t, ['armies.list']))['armies.list'] as ArmyInfo[]).find((a) => a.phase === 'outbound')!;
			await p.run(army.returnsAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		}
		const box = await inbox(p, T0 + 60_000);
		expect(box).toMatchObject({ unread: 2, more: false });
		expect(box.messages.map((m) => m.title)).toEqual(['Report from ({x}, {y})', 'Report from ({x}, {y})']);
		expect(box.messages[0].vars.x).toBe(wrap(c.x + 22)); // newest first

		await p.run(T0 + 60_000, 'mail.read', { ids: [box.messages[1].id] });
		expect(await inbox(p, T0 + 60_000)).toMatchObject({ unread: 1 });
		await p.run(T0 + 60_000, 'mail.read', { all: true });
		expect(await inbox(p, T0 + 60_000)).toMatchObject({ unread: 0 });
		await p.run(T0 + 60_000, 'mail.delete', { ids: [box.messages[0].id] });
		expect((await inbox(p, T0 + 60_000)).messages.map((m) => m.id)).toEqual([box.messages[1].id]);
		await expect(p.run(T0 + 60_000, 'mail.delete', { ids: [] })).rejects.toThrow(/ids must be/);

		// Other players' messages are out of reach.
		const q = player(undefined, unitsKernel);
		await q.start();
		await q.run(T0 + 60_000, 'mail.delete', { all: true });
		expect((await inbox(p, T0 + 60_000)).messages).toHaveLength(1);
	});
});

describe('tech tree', () => {
	type Tech = ResearchTree['techs'][number];
	const tree = async (p: ReturnType<typeof player>, now = T0) => (await p.views(now, ['research.tree']))['research.tree'] as ResearchTree;

	it('is two crossing branches in four tiers, every prerequisite known and reachable', async () => {
		const p = player();
		await p.start();
		// Only the tree: other tests register runtime nodes visible to everyone (no branch).
		const techs = (await tree(p)).techs.filter((t) => t.branch);
		const byId = new Map(techs.map((t) => [t.id, t]));
		expect(techs.filter((t) => t.branch === 'Civil')).toHaveLength(19);
		expect(techs.filter((t) => t.branch === 'Military')).toHaveLength(21);
		for (const t of techs) {
			expect(t.tier).toBeGreaterThanOrEqual(1);
			expect(t.quote).toBeTruthy();
			for (const [req, level] of Object.entries(t.requires)) {
				const r = byId.get(req);
				expect(r, `${t.id} needs ${req}`).toBeDefined();
				expect(level).toBeLessThanOrEqual(r!.maxLevel);
				expect(r!.tier).toBeLessThanOrEqual(t.tier!); // never needs a later tier
			}
		}
		// The branches cross: some civil techs need military ones and the other way round.
		const crossing = techs.flatMap((t) => Object.keys(t.requires).filter((r) => byId.get(r)!.branch !== t.branch));
		expect(crossing.length).toBeGreaterThanOrEqual(10);
		// The old techs keep their ids (and so the levels players have).
		for (const id of ['agriculture', 'forestry', 'masonry', 'mining', 'metallurgy', 'administration', 'economics'])
			expect(byId.has(id)).toBe(true);
		expect(byId.get('mining')!.name).toBe('Coinage');
		// Cards describe the effects, live from the rules.
		expect(byId.get('art-of-war')!.effects).toEqual([{ target: 'battle.attack', value: 3, percent: true }]);
		expect(byId.get('drill')!.effects).toEqual([{ target: 'time.training', value: -5, percent: true }]);
		expect(byId.get('regiments')!.unlocks).toEqual([{ building: 'barracks', from: 6, perLevel: 5 }]);
	});

	it("effects: one resource's output, training time, upkeep, battle bonuses; GM can retune them", async () => {
		const p = player({ 'armies.speed': 1e6, 'armies.minSeconds': 0, 'buildings.speed': 1e6 });
		const c = await p.start();
		await p.construct(T0, c.id, outer(c).id, 0, 'farm');
		await p.construct(T0, c.id, outer(c).id, 1, 'lumber-mill');
		await p.construct(T0 + 1_000, c.id, inner(c).id, 0, 'barracks'); // the queue holds two
		const at = T0 + 2_000;
		const before = (await p.pool(at)).rates;
		await p.run(at, 'research.setLevel', { tech: 'irrigation', level: 2 }, true);
		const after = (await p.pool(at)).rates;
		expect(after.food).toBeCloseTo(before.food * 1.1); // +5% a level, food only
		expect(after.wood).toBeCloseTo(before.wood);

		const seconds = async () =>
			((await p.views(at, ['troops.garrison']))['troops.garrison'] as GarrisonInfo).trainable.find((t) => t.unit === 'infantry-1')!.seconds;
		const base = await seconds();
		await p.run(at, 'research.setLevel', { tech: 'drill', level: 2 }, true);
		expect(await seconds()).toBeLessThan(base); // 10% faster (rounded up to whole seconds)

		// Battle: the attacker's techs become modifiers named after them.
		await p.run(at, 'research.setLevel', { tech: 'art-of-war', level: 2 }, true);
		await p.run(at, 'research.setLevel', { tech: 'foot-armour', level: 1 }, true);
		await p.run(at, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 10 }, true);
		const camp = { x: wrap(c.x + 5), y: c.y };
		await p.run(at, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...camp }, true);
		await p.run(at, 'armies.send', { from: c.id, ...camp, units: { 'infantry-1': 10 } });
		const report = ((await p.views(at + 1_500, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report.battle!.modifiers.attacker).toEqual(
			expect.arrayContaining([
				{ source: 'Art of War', stat: 'attack', percent: 6 },
				{ source: 'Foot Armour', stat: 'hp', percent: 6 },
			]),
		);

		// The GM retunes a tech: its rows are replaced; bad rows are refused.
		const retuned = player({ 'starter-research.effects': { 'art-of-war': [{ kind: 'battle', target: 'attack', value: 10 }] } });
		await retuned.start();
		expect(((await tree(retuned)).techs.find((t) => t.id === 'art-of-war') as Tech).effects).toEqual([
			{ target: 'battle.attack', value: 10, percent: true },
		]);
		const { errors } = resolveConfig(defaultKernel, {
			'starter-research.effects': { 'art-of-war': [{ kind: 'battle', target: 'speed', value: 1 }] },
		});
		expect(errors['starter-research.effects']).toMatch(/battle target/);
	});

	it('casualty bonuses for one family spare only that family', async () => {
		const shield = definePlugin({
			id: 'test-shield',
			version: '0',
			dependsOn: ['battle'],
			setup: (ctx) =>
				ctx.services
					.get('battle')
					.addModifier(async (_api, side) =>
						side.role === 'attacker' ? [{ source: 'Shield', stat: 'casualty', percent: -100, family: 'infantry' }] : [],
					),
		});
		const p = player(
			{
				'armies.speed': 1e6,
				'armies.minSeconds': 0,
				// Every family, so every lane of its random formation is manned and hits back.
				'npc-camps.defenders': {
					'npc-fortress': { defense: 1e6, units: { 'infantry-3': 400, 'archer-3': 400, 'cavalry-3': 400 } },
				},
			},
			createKernel([...plugins, shield]),
		);
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 30 }, true);
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'cavalry-1', count: 30 }, true);
		const fortress = { x: wrap(c.x + 5), y: c.y };
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-fortress', ...fortress }, true);
		await p.run(T0, 'armies.send', { from: c.id, ...fortress, units: { 'infantry-1': 30, 'cavalry-1': 30 } });
		const report = ((await p.views(T0 + 1_500, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report.losses.attacker['cavalry-1']).toBeGreaterThan(0);
		expect(report.losses.attacker['infantry-1'] ?? 0).toBe(0);
	});
});

describe('attack form', () => {
	it('offers a formation editor with what each settlement can send; lanes plus support units march out', async () => {
		const p = player({ 'armies.minSeconds': 0 }, unitsKernel);
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 10 }, true);
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'militia', count: 3 }, true); // no battle family: support
		const camp = { x: wrap(c.x + 5), y: c.y };
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...camp }, true);

		const form = (
			(await p.views(T0, ['ui.forms'], { placement: 'tile', x: String(camp.x), y: String(camp.y) }))['ui.forms'] as ResolvedForm[]
		).find((f) => f.command === 'armies.send')!;
		expect(form.fields.some((f) => f.name.startsWith('units.'))).toBe(false); // the editor chooses the units
		const widget = form.fields.find((f) => f.name === 'formation')!;
		expect(widget).toMatchObject({ type: 'widget', widget: 'battle.formation' });
		const data = widget.data as FormationWidgetData;
		expect(data.lanes).toBe(5);
		expect(data.garrisons[c.id]).toEqual({ 'infantry-1': 10, militia: 3 });
		expect(data.units).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: 'infantry-1', family: 'infantry', tier: 1 }),
				expect.objectContaining({ id: 'militia', family: null }),
			]),
		);

		// What the editor sends: five lanes, and every unit (the lanes' plus the support units).
		const lanes = [
			{ family: 'infantry', units: { 'infantry-1': 6 } },
			{ family: 'infantry', units: { 'infantry-1': 4 } },
			{ family: 'archer', units: {} },
			{ family: 'cavalry', units: {} },
			{ family: 'cavalry', units: {} },
		];
		await expect(
			p.run(T0, 'armies.send', { from: c.id, ...camp, formation: lanes, units: { 'infantry-1': 9, militia: 3 } }),
		).rejects.toThrow(/exactly the units sent/);
		await p.run(T0, 'armies.send', { from: c.id, ...camp, formation: lanes, units: { 'infantry-1': 10, militia: 3 } });
		const army = ((await p.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		expect(army.units).toEqual({ 'infantry-1': 10, militia: 3 });
	});
});

describe('GM speed-up and reports', () => {
	it('an army sped up to arrive now fights in the same commit: its report is mailed at once', async () => {
		const p = player({ 'armies.minSeconds': 600 }, unitsKernel);
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'militia', count: 3 }, true);
		await p.run(T0, 'armies.send', { from: c.id, x: wrap(c.x + 3), y: c.y, units: { militia: 3 } });
		const army = ((await p.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await p.run(T0 + 1_000, 'armies.hasten', { id: army.id, seconds: 0 }, true);
		expect((await inbox(p, T0 + 1_000)).messages).toEqual([expect.objectContaining({ kind: 'war-reports.march' })]);
		// Committed, not just shown: the army is on its way back in storage too.
		const row = await db.prepare('SELECT phase FROM armies_marches WHERE id = ?').bind(army.id).first<{ phase: string }>();
		expect(row?.phase).toBe('returning');
	});
});

describe('march missions', () => {
	const armies = async (p: ReturnType<typeof player>, now: number) => (await p.views(now, ['armies.list']))['armies.list'] as ArmyInfo[];
	const garrison = async (p: ReturnType<typeof player>, now: number, settlement: string) =>
		Object.fromEntries(
			((await p.views(now, ['troops.garrison'], { settlement }))['troops.garrison'] as GarrisonInfo).units.map((u) => [u.id, u.count]),
		);
	/** A free tile a few tiles east of `c` whose whole 3x3 is free too. */
	const freeNear = async (c: { x: number; y: number }, from = 5) => {
		for (let i = from; ; i++) {
			const t = { x: wrap(c.x + i), y: c.y };
			const taken = await db
				.prepare('SELECT 1 FROM world_map_tiles WHERE (x = ? OR x = ? OR x = ?) AND y BETWEEN ? AND ?')
				.bind(wrap(t.x - 1), t.x, wrap(t.x + 1), wrap(t.y - 1), wrap(t.y + 1))
				.first();
			if (!taken) return t;
		}
	};
	const fast = { 'armies.speed': 100, 'armies.minSeconds': 0 };

	it('transfer troops and supplies between own settlements; attacks on them are refused', async () => {
		const p = player(fast, unitsKernel);
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'militia', count: 10 }, true);
		const fortTile = await freeNear(c);
		await p.run(T0, 'settlements.found', { kind: 'fortress-military', ...fortTile, name: 'Fort' }, true);
		const resTile = await freeNear(c, fortTile.x - c.x + 3);
		await p.run(T0, 'settlements.found', { kind: 'fortress-resource', ...resTile, name: 'Mine' }, true);
		const [fort, mine] = ['Fort', 'Mine'].map((n) => p.mine(T0).then((l) => l.find((s) => s.name === n)!));
		const fortId = (await fort).id;
		const mineId = (await mine).id;

		await expect(p.run(T0, 'armies.send', { from: c.id, ...fortTile, units: { militia: 1 } })).rejects.toThrow(/your own settlement/);
		await expect(p.run(T0, 'armies.transfer', { from: c.id, ...fortTile, units: { militia: 4 }, cargo: { wood: 100 } })).rejects.toThrow(
			/carry at most 80/,
		);
		await expect(
			p.run(T0, 'armies.send', { from: c.id, ...fortTile, units: { militia: 1 }, cargo: { wood: 1 }, mission: 'attack' }),
		).rejects.toThrow(/own settlement/);

		const woodBefore = (await p.pool(T0)).amounts.wood;
		await p.run(T0, 'armies.transfer', { from: c.id, ...fortTile, units: { militia: 4 }, 'cargo.wood': 50 });
		expect((await p.pool(T0)).amounts.wood).toBeCloseTo(woodBefore - 50);
		const out = (await armies(p, T0))[0];
		expect(out).toMatchObject({ mission: 'transfer', cargo: { wood: 50 } });

		// Stationed: the trip ends at the fort, with the supplies and the unused half of the provisions.
		const fortWood = (await p.pool(T0, fortId)).amounts.wood;
		const fortFood = (await p.pool(T0, fortId)).amounts.food;
		await p.run(out.arrivesAt, 'timeline.sync', { entity: `army:${out.id}` }, true);
		expect(await armies(p, out.arrivesAt)).toEqual([]);
		expect(await garrison(p, out.arrivesAt, fortId)).toMatchObject({ militia: 4 });
		expect(await garrison(p, out.arrivesAt, c.id)).toMatchObject({ militia: 6 });
		expect((await p.pool(out.arrivesAt, fortId)).amounts.wood).toBeCloseTo(fortWood + 50);
		expect((await p.pool(out.arrivesAt, fortId)).amounts.food).toBeCloseTo(fortFood + out.provisions.food / 2, 1);

		// A resource fortress holds no troops: they unload and go back.
		await p.run(out.arrivesAt, 'armies.transfer', { from: c.id, ...resTile, units: { militia: 2 }, cargo: { stone: 30 } });
		const toMine = (await armies(p, out.arrivesAt))[0];
		const mineStone = (await p.pool(out.arrivesAt, mineId)).amounts.stone;
		const back = (await armies(p, toMine.arrivesAt))[0];
		expect(back).toMatchObject({ phase: 'returning', loot: {} });
		expect(back.report?.note).toBe('Supplies delivered');
		await p.run(toMine.arrivesAt, 'timeline.sync', { entity: `army:${toMine.id}` }, true);
		expect((await p.pool(toMine.arrivesAt, mineId)).amounts.stone).toBeCloseTo(mineStone + 30);
		await p.run(toMine.returnsAt, 'timeline.sync', { entity: `army:${toMine.id}` }, true);
		expect(await garrison(p, toMine.returnsAt, c.id)).toMatchObject({ militia: 6 });
	});

	it('found a settlement with an expedition; a lost site sends everything back', async () => {
		const p = player(fast, unitsKernel);
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'militia', count: 10 }, true);
		await p.grant(T0, 'stone', 5000);
		await p.grant(T0, 'food', 5000);
		await p.grant(T0, 'wood', 3000);
		const site = await freeNear(c);
		await expect(p.run(T0, 'settling.found', { from: c.id, ...site, kind: 'capital', units: { militia: 1 } })).rejects.toThrow(
			/cannot be founded/,
		);
		const before = (await p.pool(T0)).amounts;
		await p.run(T0, 'settling.found', {
			from: c.id,
			...site,
			kind: 'fortress-military',
			name: 'Outpost',
			units: { militia: 3 },
			cargo: { food: 40 },
		});
		// The founding cost (stone 1200 / wood 600 / food 1000) leaves with the expedition.
		const out = (await armies(p, T0))[0];
		expect(out.mission).toBe('settle');
		const after = (await p.pool(T0)).amounts;
		expect(before.stone - after.stone).toBeCloseTo(1200);
		expect(before.food - after.food).toBeCloseTo(1000 + 40 + out.provisions.food);

		await p.run(out.arrivesAt, 'timeline.sync', { entity: `army:${out.id}` }, true);
		const outpost = (await p.mine(out.arrivesAt)).find((s) => s.name === 'Outpost')!;
		expect(outpost).toMatchObject({ kind: 'fortress-military', x: site.x, y: site.y });
		expect(await garrison(p, out.arrivesAt, outpost.id)).toMatchObject({ militia: 3 });
		expect(await armies(p, out.arrivesAt)).toEqual([]);

		// Someone takes the next site first: the expedition comes back with the materials and supplies.
		const t1 = out.arrivesAt;
		const site2 = await freeNear(c, site.x - c.x + 3);
		await p.run(t1, 'settling.found', { from: c.id, ...site2, kind: 'fortress-military', units: { militia: 2 }, cargo: { wood: 20 } });
		const second = (await armies(p, t1))[0];
		await p.run(t1, 'settlements.found', { kind: 'fortress-resource', ...site2 }, true);
		const failed = (await armies(p, second.arrivesAt))[0];
		expect(failed.report?.note).toMatch(/Could not found the settlement: That tile is already occupied/);
		expect(failed.loot).toMatchObject({ stone: 1200, wood: 620, food: 1000 });

		// A recall brings the materials back too.
		const site3 = await freeNear(c, site2.x - c.x + 3);
		await p.run(second.arrivesAt, 'settling.found', { from: c.id, ...site3, kind: 'fortress-military', units: { militia: 1 } });
		const third = (await armies(p, second.arrivesAt)).find((a) => a.phase === 'outbound')!;
		await p.run(second.arrivesAt + 1_000, 'armies.recall', { id: third.id });
		expect((await armies(p, second.arrivesAt + 1_000)).find((a) => a.id === third.id)!.loot).toMatchObject({ stone: 1200, wood: 600 });
	});
});

describe('GM march tools', () => {
	const armies = async (p: ReturnType<typeof player>, now: number) => (await p.views(now, ['armies.list']))['armies.list'] as ArmyInfo[];

	it('speed up one leg of a march (GM only); the rest of the trip keeps its length', async () => {
		const p = player({ 'armies.minSeconds': 1200 }, unitsKernel);
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'militia', count: 5 }, true);
		const tile = { x: wrap(c.x + 3), y: c.y };
		await p.run(T0, 'armies.send', { from: c.id, ...tile, units: { militia: 5 } });
		const out = (await armies(p, T0))[0];
		expect(out).toMatchObject({ arrivesAt: T0 + 1_200_000, returnsAt: T0 + 2_400_000 });
		await expect(p.run(T0, 'armies.hasten', { id: out.id, seconds: 60 })).rejects.toThrow(/Unknown command/); // players cannot see it

		// 5 minutes off the way out: arrives at 900 s, back at 2100 s.
		await p.run(T0 + 1_000, 'armies.hasten', { id: out.id, minutes: 5 }, true);
		expect((await armies(p, T0 + 1_000))[0]).toMatchObject({ arrivesAt: T0 + 900_000, returnsAt: T0 + 2_100_000 });
		expect((await armies(p, T0 + 900_000))[0].phase).toBe('returning');

		// Finish the way home at once.
		await p.run(T0 + 1_000_000, 'armies.hasten', { id: out.id, seconds: 0 }, true);
		expect(await armies(p, T0 + 1_000_000)).toEqual([]);
		await p.run(T0 + 1_000_000, 'timeline.sync', { entity: `army:${out.id}` }, true);
		const g = (await p.views(T0 + 1_000_000, ['troops.garrison']))['troops.garrison'] as GarrisonInfo;
		expect(g.units).toEqual(expect.arrayContaining([{ id: 'militia', count: 5 }]));
		await expect(p.run(T0 + 1_000_000, 'armies.hasten', { id: out.id, seconds: 0 }, true)).rejects.toThrow(/No such army/);
	});
});

describe('formations', () => {
	const formation = async (p: ReturnType<typeof player>, now = T0) =>
		(await p.views(now, ['battle.formation']))['battle.formation'] as BattleFormationInfo;

	it('defend with a default formation (every family, stable) until the player sets one', async () => {
		const p = player();
		const c = await p.start();
		const first = await formation(p);
		expect(first.saved).toBe(false);
		expect(first.lanes).toHaveLength(5);
		expect(new Set(first.lanes)).toEqual(new Set(['infantry', 'archer', 'cavalry']));
		expect((await formation(p)).lanes).toEqual(first.lanes);

		const lanes = ['cavalry', 'cavalry', 'infantry', 'archer', 'archer'];
		await expect(
			p.run(T0, 'battle.setFormation', { settlement: c.id, lanes: ['cavalry', 'cavalry', 'infantry', 'infantry', 'infantry'] }),
		).rejects.toThrow(/Every unit family needs a lane/);
		await p.run(T0, 'battle.setFormation', { settlement: c.id, lanes });
		expect(await formation(p)).toMatchObject({ lanes, saved: true });

		// The form lives on the wall's entry, not on the settlement page or other buildings.
		const formOn = async (placement: string, type?: string) =>
			((await p.views(T0, ['ui.forms'], { placement, settlement: c.id, ...(type ? { type } : {}) }))['ui.forms'] as ResolvedForm[]).some(
				(f) => f.command === 'battle.setFormation',
			);
		expect(await formOn('building', 'wall')).toBe(true);
		expect(await formOn('building', 'barracks')).toBe(false);
		expect(await formOn('settlement')).toBe(false);
	});

	it('marches out in lanes: split evenly from the form, or exactly as given through the API', async () => {
		const p = player({ 'armies.speed': 1e6, 'armies.minSeconds': 0 });
		const c = await p.start();
		for (const r of ['food', 'metal', 'gold', 'wood']) await p.grant(T0, r, 10_000);
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 10 }, true);
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'cavalry-2', count: 3 }, true);
		const tile = { x: wrap(c.x + 9), y: c.y };
		const options = async () =>
			JSON.parse(
				(await db
					.prepare('SELECT options FROM armies_marches WHERE player_id = ? ORDER BY rowid DESC LIMIT 1')
					.bind(p.id)
					.first<{ options: string }>())!.options,
			);

		await expect(
			p.run(T0, 'armies.send', {
				from: c.id,
				...tile,
				'units.infantry-1': 5,
				lane1: 'archer',
				lane2: 'archer',
				lane3: 'archer',
				lane4: 'archer',
				lane5: 'archer',
			}),
		).rejects.toThrow(/No lane for Infantry/);
		await p.run(T0, 'armies.send', {
			from: c.id,
			...tile,
			'units.infantry-1': 5,
			'units.cavalry-2': 3,
			lane1: 'infantry',
			lane2: 'cavalry',
			lane3: 'infantry',
			lane4: 'cavalry',
			lane5: 'archer',
		});
		expect((await options()).formation).toEqual([
			{ family: 'infantry', units: { 'infantry-1': 3 } },
			{ family: 'cavalry', units: { 'cavalry-2': 2 } },
			{ family: 'infantry', units: { 'infantry-1': 2 } },
			{ family: 'cavalry', units: { 'cavalry-2': 1 } },
			{ family: 'archer', units: {} },
		]);

		const lanes = [
			{ family: 'infantry', units: { 'infantry-1': 4 } },
			{ family: 'infantry', units: { 'infantry-1': 1 } },
			{ family: 'archer', units: {} },
			{ family: 'archer', units: {} },
			{ family: 'archer', units: {} },
		];
		await expect(p.run(T0, 'armies.send', { from: c.id, ...tile, units: { 'infantry-1': 4 }, formation: lanes })).rejects.toThrow(
			/exactly the units sent/,
		);
		await p.run(T0, 'armies.send', { from: c.id, ...tile, units: { 'infantry-1': 5 }, formation: lanes });
		expect((await options()).formation).toEqual(lanes);
	});
});

describe('pvp', () => {
	it('does not hurt players under beginner protection', async () => {
		const a = player({ 'armies.speed': 1e6, 'armies.minSeconds': 0 }, unitsKernel);
		const b = player(undefined, unitsKernel);
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
		const fast = { 'armies.speed': 1e6, 'armies.minSeconds': 0, 'pvp.protectionHours': 0 };
		const a = player(fast);
		const b = player(fast);
		const ca = await a.start();
		const cb = await b.start();
		// 200 tier-2 cavalry, 40 per lane (attack 1104 each), against 5 tier-1 infantry behind a level-1 wall.
		await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'cavalry-2', count: 200 }, true);
		await b.run(T0, 'troops.grant', { settlement: cb.id, unit: 'infantry-1', count: 5 }, true);
		await a.run(T0, 'armies.send', { from: ca.id, x: cb.x, y: cb.y, units: { 'cavalry-2': 200 } });

		// The defender sees it coming (without unit details).
		const incoming = (await b.views(T0, ['armies.incoming']))['armies.incoming'] as { settlement: string }[];
		expect(incoming).toEqual([expect.objectContaining({ settlement: cb.id })]);

		// Process the arrival (as the sweep would) and look at the result.
		const army = ((await a.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const report = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report).toMatchObject({ outcome: 'victory', target: { kind: 'capital' } });
		expect(report.battle).toMatchObject({ wins: { attacker: 5, defender: 0 }, grade: { attacker: 'crushing', defender: 'routed' } });
		expect(report.battle!.modifiers.defender).toContainEqual(expect.objectContaining({ source: 'Wall Lv 1', flat: 100 }));
		expect(report.losses.defender['infantry-1']).toBeGreaterThanOrEqual(1);
		const taken = Object.values(report.loot).reduce((x, y) => x + y, 0);
		expect(taken).toBeGreaterThan(0);

		// The defender's formation was fixed by the battle, and the losses are real.
		expect(((await b.views(army.arrivesAt, ['battle.formation']))['battle.formation'] as BattleFormationInfo).saved).toBe(true);
		const defenses = (await b.views(army.arrivesAt, ['pvp.defenses']))['pvp.defenses'] as { report: { outcome: string } }[];
		expect(defenses).toHaveLength(1);
		// Both sides get a report in their mailbox.
		expect((await inbox(b, army.arrivesAt)).messages).toEqual([
			expect.objectContaining({ kind: 'war-reports.defense', title: '{settlement} was raided by {name}', read: false }),
		]);
		expect((await inbox(a, army.arrivesAt)).messages).toEqual([
			expect.objectContaining({ kind: 'war-reports.march', title: 'Victory at ({x}, {y})', vars: expect.objectContaining({ x: cb.x }) }),
		]);
		const g = (await b.views(army.arrivesAt, ['troops.garrison']))['troops.garrison'] as GarrisonInfo;
		expect(g.units.find((u) => u.id === 'infantry-1')?.count ?? 0).toBe(5 - report.losses.defender['infantry-1']);
		expect((await b.pool(army.arrivesAt)).amounts.food).toBeLessThan(500);
	});

	it('plunders by result: a share of each stock, minus the hidden store, within what survivors carry', async () => {
		// The design example (§3.9). No wall defence, so 120 tier-1 cavalry win all 5 lanes unharmed.
		const rules = {
			'armies.speed': 1e6,
			'armies.minSeconds': 0,
			'pvp.protectionHours': 0,
			'starter-defense.wallDefense': { capital: 0 },
			'buildings.speed': 1e6,
		};
		const a = player(rules);
		const b = player(rules);
		const ca = await a.start();
		const cb = await b.start();
		await b.construct(T0, cb.id, inner(cb).id, 0, 'hidden-store');
		await b.run(T0 + 1_000, 'buildings.setLevel', { settlement: cb.id, district: inner(cb).id, slot: 0, level: 2 }, true);
		await b.grant(T0 + 1_000, 'food', 10_000 - (await b.pool(T0 + 1_000)).amounts.food);
		await b.grant(T0 + 1_000, 'wood', 2_000 - (await b.pool(T0 + 1_000)).amounts.wood);
		await a.run(T0 + 1_000, 'troops.grant', { settlement: ca.id, unit: 'cavalry-1', count: 120 }, true);
		await a.run(T0 + 1_000, 'armies.send', { from: ca.id, x: cb.x, y: cb.y, units: { 'cavalry-1': 120 } });
		const army = ((await a.views(T0 + 1_000, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const report = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report.battle!.grade.attacker).toBe('crushing');
		// 50%: food 5000, wood 1000 (stone, metal, currency are all under the 1000 protected);
		// 6000 > 120 x 25 = 3000 carry, so both halve.
		expect(report.loot).toEqual({ food: 2500, wood: 500 });
	});

	it('fights lane by lane: the design example of 100 against 100 tier-1 cavalry', async () => {
		const fast = { 'armies.speed': 1e6, 'armies.minSeconds': 0, 'pvp.protectionHours': 0 };
		const a = player(fast);
		const b = player(fast);
		const ca = await a.start();
		const cb = await b.start();
		await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'cavalry-1', count: 100 }, true);
		await b.run(T0, 'troops.grant', { settlement: cb.id, unit: 'cavalry-1', count: 100 }, true);
		await b.run(T0, 'battle.setFormation', { settlement: cb.id, lanes: ['cavalry', 'infantry', 'archer', 'archer', 'archer'] });
		const empty = { family: 'cavalry', units: {} };
		await a.run(T0, 'armies.send', {
			from: ca.id,
			x: cb.x,
			y: cb.y,
			units: { 'cavalry-1': 100 },
			formation: [{ family: 'cavalry', units: { 'cavalry-1': 100 } }, empty, empty, empty, empty],
		});
		const army = ((await a.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const { battle, losses } = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		// Lane 1: attack 1150 vs defence 1000 + wall 100: the attacker wins it. The defender takes
		// 50 damage (5 dead), the attacker 1150 - 1000 = 150 (15 dead).
		expect(battle!.lanes[0]).toMatchObject({
			winner: 'attacker',
			attacker: { attack: 1150, defense: 1000, hp: 1000 },
			defender: { defense: 1100 },
		});
		expect(battle!.lanes[0].defender.lost).toEqual({ 'cavalry-1': 5 });
		expect(battle!.lanes[0].attacker.lost).toEqual({ 'cavalry-1': 15 });
		// Empty attacking lanes: no attack; archers counter cavalry, so their wall defence counts x3.
		expect(battle!.lanes[1]).toMatchObject({ winner: 'defender', attacker: { attack: 0, counters: true }, defender: { defense: 100 } });
		expect(battle!.lanes[2]).toMatchObject({ winner: 'defender', defender: { defense: 300, counters: true } });
		// 1 lane of 5: the attacker is routed (x0.2), the defender won (x0.65).
		expect(battle).toMatchObject({ wins: { attacker: 1, defender: 4 }, grade: { attacker: 'routed', defender: 'victory' } });
		expect(losses).toEqual({ attacker: { 'cavalry-1': 3 }, defender: { 'cavalry-1': 3 } });
		// The routed attacker gains nothing; the defender's 3 dead promote 3 survivors (§2.6).
		const report = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report.promoted).toEqual({ attacker: [], defender: [{ from: 'cavalry-1', to: 'cavalry-2', count: 3 }] });
		const g = (await b.views(army.arrivesAt, ['troops.garrison']))['troops.garrison'] as GarrisonInfo;
		expect(Object.fromEntries(g.units.map((u) => [u.id, u.count]))).toEqual({ 'cavalry-1': 94, 'cavalry-2': 3 });
	});

	it('lets auxiliary units stay out of the lanes and change losses through casualty hooks', async () => {
		// A stand-in for an "auxiliary units" plugin: medics march along without fighting; each
		// medic saves one of the fallen (final step), and the change shows in the report.
		const medics = definePlugin({
			id: 'test-medics',
			version: '0',
			dependsOn: ['troops', 'battle'],
			setup(ctx) {
				ctx.services.get('troops').define({
					id: 'medic',
					name: 'Medic',
					stats: { attack: 0, defense: 0, hp: 1, speed: 100, carry: 0, cost: {}, seconds: 1, upkeep: {} },
				});
				ctx.services.get('battle').addCasualtyHook({
					source: 'Medics',
					async final(_api, { units, losses }) {
						let saved = units.medic ?? 0;
						if (!saved) return null;
						const out: Record<string, number> = {};
						for (const [u, n] of Object.entries(losses)) {
							const s = Math.min(n, saved);
							saved -= s;
							out[u] = n - s;
						}
						return out;
					},
				});
			},
		});
		const kernel = createKernel([...plugins, medics]);
		const fast = { 'armies.speed': 1e6, 'armies.minSeconds': 0, 'pvp.protectionHours': 0 };
		const a = player(fast, kernel);
		const b = player(fast, kernel);
		const ca = await a.start();
		const cb = await b.start();
		// The 3.8 example again (the attacker loses 3), now with 2 medics along.
		await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'cavalry-1', count: 100 }, true);
		await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'medic', count: 2 }, true);
		await b.run(T0, 'troops.grant', { settlement: cb.id, unit: 'cavalry-1', count: 100 }, true);
		await b.run(T0, 'battle.setFormation', { settlement: cb.id, lanes: ['cavalry', 'infantry', 'archer', 'archer', 'archer'] });
		const empty = { family: 'cavalry', units: {} };
		await a.run(T0, 'armies.send', {
			from: ca.id,
			x: cb.x,
			y: cb.y,
			units: { 'cavalry-1': 100, medic: 2 },
			formation: [{ family: 'cavalry', units: { 'cavalry-1': 100 } }, empty, empty, empty, empty],
		});
		const army = ((await a.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const back = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		expect(back.report!.losses.attacker).toEqual({ 'cavalry-1': 1 });
		expect(back.report!.battle!.adjustments).toContainEqual({ side: 'attacker', stage: 'final', source: 'Medics' });
		expect(back.units).toMatchObject({ 'cavalry-1': 99, medic: 2 });
	});

	it('promotes survivors with the quota of the fallen, tier by tier and then across families', () => {
		const battle = defaultKernel.services.get('battle');
		// The design example: 100 tier-1 dead, 20 survive -> all 20 promote; 80 left / 2 = 40 tier-2
		// quota, which promotes 20 of the 30 who were tier 2 from the start (not the new ones).
		expect(battle.promotions({ 'infantry-1': 120, 'infantry-2': 30 }, { 'infantry-1': 100 })).toEqual([
			{ from: 'infantry-1', to: 'infantry-2', count: 20 },
			{ from: 'infantry-2', to: 'infantry-3', count: 20 },
		]);
		// No infantry survived: their quota promotes archers 1:1; 5 left / 2 = 2.5 at tier 2 -> one cavalry.
		expect(battle.promotions({ 'infantry-1': 10, 'archer-1': 5, 'cavalry-2': 3 }, { 'infantry-1': 10 })).toEqual([
			{ from: 'archer-1', to: 'archer-2', count: 5 },
			{ from: 'cavalry-2', to: 'cavalry-3', count: 1 },
		]);
		// The top tier cannot go higher.
		expect(battle.promotions({ 'cavalry-6': 15 }, { 'cavalry-6': 10 })).toEqual([]);
	});
});

describe('NPC settlements', () => {
	it('counts battle modifiers such as a hero leading the army', async () => {
		const hero = definePlugin({
			id: 'test-general',
			version: '0',
			dependsOn: ['battle'],
			setup(ctx) {
				ctx.services
					.get('battle')
					.addModifier(async (_api, side) =>
						side.role === 'attacker' ? [{ source: 'Hero: Zhang Fei', stat: 'attack', percent: 100 }] : [],
					);
			},
		});
		const p = player({ 'armies.speed': 1e6, 'armies.minSeconds': 0 }, createKernel([...plugins, hero]));
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 20 }, true);
		const at = { x: wrap(c.x + 5), y: c.y };
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...at }, true);
		await p.run(T0, 'armies.send', { from: c.id, ...at, units: { 'infantry-1': 20 } });
		const { battle } = ((await p.views(T0 + 1_500, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(battle!.modifiers.attacker).toEqual([{ source: 'Hero: Zhang Fei', stat: 'attack', percent: 100 }]);
		// 4 infantry per lane, attack 10 each, doubled — and tripled again against archers.
		for (const lane of battle!.lanes) expect(lane.attacker.attack).toBeCloseTo(4 * 10 * 2 * (lane.attacker.counters ? 3 : 1));
	});

	it('can be raided: outposts give food, fortresses give troops, strong defence wins', async () => {
		const p = player({
			'armies.speed': 1e6,
			'armies.minSeconds': 0,
			'npc-camps.defenders': {
				'npc-outpost': { defense: 10, units: {} },
				'npc-fortress': { defense: 1e6, units: { 'infantry-1': 400 } },
			},
		});
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'cavalry-2', count: 50 }, true);
		// Place an outpost and a fortress right next to the capital's ring.
		const place = async (kind: string, dx: number) => {
			await p.run(T0, 'npc-camps.spawnAt', { kind, x: wrap(c.x + dx), y: c.y }, true);
			return { x: wrap(c.x + dx), y: c.y };
		};
		const outpost = await place('npc-outpost', 5);
		const fortress = await place('npc-fortress', 7);

		await p.run(T0, 'armies.send', { from: c.id, x: outpost.x, y: outpost.y, units: { 'cavalry-2': 25 } });
		await p.run(T0, 'armies.send', { from: c.id, x: fortress.x, y: fortress.y, units: { 'cavalry-2': 25 } });
		// Each leg takes 1 s at this speed: look while they are on the way back.
		const list = (await p.views(T0 + 1_500, ['armies.list']))['armies.list'] as ArmyInfo[];
		const raid = list.find((a) => a.target.x === outpost.x)!;
		expect(raid.report).toMatchObject({ outcome: 'victory', target: { kind: 'npc-outpost' } });
		expect(raid.loot.food).toBeGreaterThan(0); // the outpost's starting food, up to what survivors carry
		const siege = list.find((a) => a.target.x === fortress.x)!;
		expect(siege.report?.outcome).toBe('defeat');
		expect(siege.units['cavalry-2']).toBeLessThan(25);
	});

	it('are registered by their own plugin and spawned by the GM onto free land', async () => {
		const gm = player(undefined, unitsKernel);
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

describe('heroes', () => {
	const candidates = async (p: ReturnType<typeof player>, now: number) =>
		(await p.views(now, ['heroes.candidates']))['heroes.candidates'] as HeroCandidates[];
	const heroes = async (p: ReturnType<typeof player>, now: number) => (await p.views(now, ['heroes.list']))['heroes.list'] as HeroInfo[];

	it('are recruited at a venue: candidates stay put within a window, each recruited once, up to the limit', async () => {
		const p = player({ 'buildings.speed': 1e6, 'heroes.cap': 1 });
		const c = await p.start();
		expect(await candidates(p, T0)).toEqual([]); // no tavern yet
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		const at = T0 + 1_000;
		const [tavern] = await candidates(p, at);
		expect(tavern).toMatchObject({ venue: 'tavern', cost: { gold: 500 } });
		expect(tavern.candidates).toHaveLength(2);
		const first = tavern.candidates[0]!;
		expect(first.gender).toBe('m');
		expect(first.surname).toMatch(/^s:/);
		expect(first.attrs.might).toBeGreaterThanOrEqual(60);
		expect(first.attrs.might).toBeLessThanOrEqual(95);
		// One of might / leadership / strategy is near its top.
		expect(first.attrs.might >= 90 || first.attrs.leadership >= 85 || first.attrs.strategy >= 55).toBe(true);
		expect((await candidates(p, at + 60_000))[0].candidates[0]).toEqual(first); // the same all window long

		await p.grant(at, 'gold', 1000);
		const gold = (await p.pool(at)).amounts.gold;
		await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		expect((await p.pool(at)).amounts.gold).toBeCloseTo(gold - 500);
		const [hero] = await heroes(p, at);
		expect(hero).toMatchObject({
			surname: first.surname,
			given: first.given,
			attrs: first.attrs,
			home: c.id,
			duty: 'idle',
			origin: 'tavern',
		});
		expect((await candidates(p, at))[0].candidates[0]).toBeNull();
		await expect(p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 })).rejects.toThrow(/no longer available/);
		await expect(p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 1 })).rejects.toThrow(/Hero limit/);
		// A new window brings new candidates.
		const later = (await candidates(p, at + 9 * 3600_000))[0].candidates;
		expect(later[0]).not.toBeNull();
		expect(later[0]).not.toEqual(first);

		await p.run(at, 'heroes.dismiss', { hero: hero.id });
		expect(await heroes(p, at)).toEqual([]);
	});

	it('on duty give their bonuses: a governor raises production and cuts build time and upkeep', async () => {
		const p = player({ 'starter-heroes.limits': { governors: 1 } });
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern'); // 90 s
		await p.construct(T0, c.id, outer(c).id, 0, 'farm'); // 10 s
		const at = T0 + 100_000;
		await p.grant(at, 'gold', 2000);
		await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 1 });
		const [a, b] = await heroes(p, at);
		await p.run(at, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 100 }, true);
		const before = (await p.pool(at)).upkeep.food;
		const secondsBefore = (await p.detail(at)).districts[0].slots[1].options.find((o) => o.building === 'palace')!.seconds;

		await expect(p.run(at, 'heroes.assign', { hero: a.id, duty: 'scholar', target: c.id })).rejects.toThrow(/Requires Institute/);
		await p.run(at + 10_000, 'heroes.assign', { hero: a.id, duty: 'governor', target: c.id });
		await expect(p.run(at + 10_000, 'heroes.assign', { hero: b.id, duty: 'governor', target: c.id })).rejects.toThrow(/At most 1/);
		const pool = await p.pool(at + 10_000);
		expect(pool.factor).toBeCloseTo(1 + (a.attrs.governance * 0.2) / 100);
		expect(pool.upkeep.food).toBeCloseTo(before * (1 - (a.attrs.charm * 0.2) / 100));
		const secondsAfter = (await p.detail(at + 10_000)).districts[0].slots[1].options.find((o) => o.building === 'palace')!.seconds;
		expect(secondsAfter).toBeLessThan(secondsBefore);
		// The settlement lists its posts: the governor and what it gives; b is idle, so it defends.
		const posts = (await p.views(at + 10_000, ['starter-heroes.posts'], { settlement: c.id }))['starter-heroes.posts'] as HeroPost[];
		expect(posts.find((x) => x.post === 'governor')).toMatchObject({
			limit: 1,
			heroes: [a.id],
			effects: expect.arrayContaining([{ effect: 'production', percent: a.attrs.governance * 0.2 }]),
		});
		expect(posts.find((x) => x.post === 'scholar')).toMatchObject({ building: 'institute', heroes: [] });
		expect(posts.find((x) => x.post === 'defend')!.heroes).toEqual(expect.arrayContaining([a.id, b.id]));
		// Production before the assignment was banked at the old rate: the farm gave 1 food/s until then.
		const food = (await p.pool(at + 20_000)).amounts.food;
		const expected = (await p.pool(at + 10_000)).amounts.food + 10 * (pool.factor - pool.upkeep.food);
		expect(food).toBeCloseTo(expected, 3);
	});

	it('serve only where they are attached, unless a duty says otherwise; moving home ends a post left behind', async () => {
		// A plugin's own duty that may be held anywhere (e.g. an envoy at another settlement).
		const envoy = definePlugin({
			id: 'test-envoy',
			version: '0',
			dependsOn: ['heroes'],
			setup: (ctx) => ctx.services.get('heroes').defineDuty({ id: 'envoy', name: 'Envoy', inTown: false, manual: true, anywhere: true }),
		});
		const p = player(undefined, createKernel([...plugins, envoy]));
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern'); // 90 s
		const at = T0 + 100_000;
		await p.grant(at, 'gold', 2000);
		await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 1 });
		const [a, b] = await heroes(p, at);
		const fort = { x: wrap(c.x + 6), y: c.y };
		await p.run(at, 'settlements.found', { kind: 'city', ...fort, name: 'Second' }, true);
		const second = (await p.mine(at)).find((s) => s.name === 'Second')!;

		await expect(p.run(at, 'heroes.assign', { hero: a.id, duty: 'governor', target: second.id })).rejects.toThrow(
			/only in the settlement it is attached to/,
		);
		await p.run(at, 'heroes.assign', { hero: a.id, duty: 'governor', target: c.id });
		await p.run(at, 'heroes.assign', { hero: b.id, duty: 'envoy', target: second.id }); // allowed by its plugin

		// Moving the governor ends its post at home (and its bonus); the envoy keeps its post.
		const factor = (await p.pool(at, c.id)).factor;
		await p.run(at, 'heroes.setHome', { hero: a.id, settlement: second.id });
		await p.run(at, 'heroes.setHome', { hero: b.id, settlement: second.id });
		const now = await heroes(p, at);
		expect(now.find((h) => h.id === a.id)).toMatchObject({ duty: 'idle', home: second.id });
		expect(now.find((h) => h.id === b.id)).toMatchObject({ duty: 'envoy', dutyTarget: second.id });
		expect((await p.pool(at, c.id)).factor).toBeLessThan(factor);
	});

	it('lead armies only when idle and at home; the send form offers exactly those, once each, with a supplies budget', async () => {
		const p = player(undefined, unitsKernel);
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern'); // 90 s
		const at = T0 + 100_000;
		await p.grant(at, 'gold', 2000);
		await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 1 });
		const [a, b] = await heroes(p, at);
		await p.run(at, 'heroes.assign', { hero: a.id, duty: 'governor', target: c.id });
		await p.run(at, 'troops.grant', { settlement: c.id, unit: 'militia', count: 5 }, true);
		// Our own fortress: the transfer form carries supplies and heroes.
		const tile = { x: wrap(c.x + 6), y: c.y };
		await p.run(at, 'settlements.found', { kind: 'fortress-military', ...tile }, true);

		const form = (
			(await p.views(at, ['ui.forms'], { placement: 'tile', x: String(tile.x), y: String(tile.y) }))['ui.forms'] as ResolvedForm[]
		).find((f) => f.command === 'armies.transfer')!;
		const slot = form.fields.find((f) => f.name === 'hero1')!;
		expect(slot.distinct).toBe('heroes');
		expect(slot.options!.map((o) => o.value)).toEqual(['', b.id]); // the governor stays at its post
		expect(slot.options![1].when).toEqual({ from: c.id });
		expect(form.budgets).toEqual([
			{
				label: 'Supplies',
				use: ['cargo.stone', 'cargo.wood', 'cargo.food', 'cargo.metal', 'cargo.gold'],
				capacity: { 'units.militia': 20 },
			},
		]);

		await expect(p.run(at, 'armies.transfer', { from: c.id, ...tile, units: { militia: 1 }, hero1: a.id })).rejects.toThrow(/busy/);
		await p.run(at, 'armies.transfer', { from: c.id, ...tile, units: { militia: 1 }, hero1: b.id, hero2: b.id });
		expect((await heroes(p, at)).find((h) => h.id === b.id)!.duty).toBe('command');
	});

	it('lead armies and defend their settlement, adding their attributes in battle', async () => {
		const fast = { 'armies.speed': 1e6, 'armies.minSeconds': 0, 'pvp.protectionHours': 0 };
		const recruit = async (p: ReturnType<typeof player>, c: SettlementDetail) => {
			await p.construct(T0, c.id, inner(c).id, 0, 'tavern'); // 90 s
			await p.grant(T0 + 100_000, 'gold', 1000);
			await p.run(T0 + 100_000, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
			return (await heroes(p, T0 + 100_000))[0];
		};
		const a = player(fast);
		const b = player(fast);
		const ca = await a.start();
		const cb = await b.start();
		const ha = await recruit(a, ca);
		const hb = await recruit(b, cb);
		const at = T0 + 100_000;
		await a.run(at, 'troops.grant', { settlement: ca.id, unit: 'cavalry-1', count: 50 }, true);
		await b.run(at, 'troops.grant', { settlement: cb.id, unit: 'infantry-1', count: 10 }, true);
		await expect(b.run(at, 'heroes.setDefenseOrder', { settlement: cb.id, heroes: [ha.id] })).rejects.toThrow(
			/attached to this settlement/,
		);

		await a.run(at, 'armies.send', { from: ca.id, x: cb.x, y: cb.y, units: { 'cavalry-1': 50 }, heroes: [ha.id] });
		expect((await heroes(a, at))[0].duty).toBe('command');
		const army = ((await a.views(at, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const { battle } = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(battle!.modifiers.attacker).toContainEqual({
			source: 'Commanding heroes',
			stat: 'attack',
			percent: ha.attrs.might * 0.2,
			flat: undefined,
		});
		expect(battle!.modifiers.defender).toContainEqual({
			source: 'Defending heroes',
			stat: 'defense',
			percent: hb.attrs.leadership * 0.2,
			flat: undefined,
		});
		expect(battle!.modifiers.defender).toContainEqual(
			expect.objectContaining({ source: 'Defending heroes', stat: 'casualty', percent: -hb.attrs.strategy * 0.2 }),
		);
		// Back home, the hero is free again.
		await a.run(army.returnsAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		expect((await heroes(a, army.returnsAt))[0].duty).toBe('idle');
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
