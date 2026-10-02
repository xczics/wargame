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
import clock from '../examples/clock/server';
import otherworld from '../examples/otherworld/server';
import watchtower from '../examples/watchtower/server';
import { plugins } from '../src/plugins';
import { wrap } from '../src/plugins/world-map';
import type {
	ArmyInfo,
	BattleFormationInfo,
	DefenseMail,
	EquipmentBag,
	GarrisonInfo,
	HeroCandidates,
	HeroInfo,
	HeroPost,
	HeroRoles,
	IncomingArmy,
	ItemStack,
	MailInbox,
	MapMarker,
	MapTile,
	NearbyOverview,
	PrestigeStatus,
	RealmMail,
	RealmShop,
	RealmsOverview,
	ResearchTree,
	ResolvedForm,
	ResourcePool,
	SettlementDetail,
	SettlementSummary,
	ShopStore,
	SiegeWall,
	TerrainWindow,
	UiLayout,
	UnitNumbers,
} from '../src/shared/api';
import type { CardsData, CellsData, GridData, LanesInputData, SyncData, RowsData, TimersData, TreeData } from '../src/shared/ui';
import { fightGroups } from '../src/shared/realms';

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
		// Cities and fortresses start at 0 (techs, prestige and items raise them); tests that found some need a few.
		'player-settlements.limits': { city: 2, 'fortress-resource': 3, 'fortress-military': 3 },
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
		// 22 slots, plus one holding the level-1 wall every settlement starts with.
		expect(inner(capital).slots).toHaveLength(23);
		expect(inner(capital).slots[22].current).toMatchObject({ building: 'wall', level: 1 });
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

	it('draws the City page as generic widgets: the district board and one card per slot', async () => {
		const p = player();
		const c = await p.start();
		await p.construct(T0, c.id, outer(c).id, 0, 'farm');
		const v = await p.views(T0 + 5_000, ['settlements.districts', 'buildings.slots']);
		const board = v['settlements.districts'] as CellsData;
		// 3x3 around the inner city; north (higher y) on the first row.
		expect(board.columns).toBe(3);
		expect(board.cells[4]).toMatchObject({ id: inner(c).id, tone: 'strong', selectable: true });
		expect(board.defaultSelected).toBe(inner(c).id);
		for (const d of c.districts.filter((x) => x.type === 'outer')) {
			const at = board.cells.findIndex((x) => x?.id === d.id);
			expect([(at % 3) - 1, 1 - Math.floor(at / 3)]).toEqual([wrap(d.x - c.x), wrap(d.y - c.y)]);
		}
		// Free neighbours where an outer city may go run the command, after asking.
		const add = board.cells.find((x) => x?.action);
		expect(add?.action).toMatchObject({
			command: 'settlements.addOuter',
			payload: { settlement: c.id },
			confirm: { text: expect.any(String) },
		});

		const slots = v['buildings.slots'] as CardsData;
		expect(slots.defaultGroup).toBe(inner(c).id);
		expect(slots.groups?.map((g) => g.id)).toEqual(c.districts.map((d) => d.id));
		const building = slots.cards.find((x) => x.id === `${c.id}/${outer(c).id}/0`)!;
		expect(building.where).toEqual(['page:city', `building#${c.id}/${outer(c).id}/0`]);
		expect(building.lines).toContainEqual({ text: { text: '→ Lv {0}', vars: { 0: 1 } }, startedAt: T0, endsAt: T0 + 10_000 });
		expect(building.actions?.map((a) => a.command ?? a.entry?.kind)).toEqual(['buildings.cancel', 'building']);
		// An empty slot lists what can be built there, each a construct button.
		const empty = slots.cards.find((x) => x.id === `${c.id}/${inner(c).id}/0`)!;
		expect(empty.detail?.choices?.map((x) => x.action.payload?.building)).toContain('warehouse');
		expect(slots.placement).toBe('settlement');
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

	it('builds faster with a seat of government (palace, prefecture office); recruiting halls in the capital only', async () => {
		const p = player();
		const c = await p.start();
		for (const r of ['food', 'wood', 'stone', 'metal', 'gold']) await p.grant(T0, r, 1e6);
		const seconds = async (t: number) => inner(await p.detail(t)).slots[1].options.find((o) => o.building === 'warehouse')!.seconds;
		const before = await seconds(T0);
		await p.construct(T0, c.id, inner(c).id, 0, 'palace');
		// Once it stands (level 1): +3% construction speed in this settlement.
		const later = T0 + 30 * 86_400_000;
		expect(inner(await p.detail(later)).slots[0].current).toMatchObject({ building: 'palace', level: 1 });
		expect(await seconds(later)).toBe(Math.ceil(before / 1.03));
		// A city cannot recruit heroes any more (tavern, academy, music house: capital only).
		await p.run(later, 'settlements.found', { kind: 'city', x: wrap(c.x + 8), y: c.y, name: 'Far' }, true);
		const far = (await p.mine(later)).find((x) => x.name === 'Far')!;
		const choices = inner(await p.detail(later, far.id)).slots[0].options.map((o) => o.building);
		expect(choices).not.toContain('tavern');
		expect(choices).toContain('town-hall');
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
			const tile = d.nextOuter!.candidates[0];
			await p.run(
				T0,
				privileged ? 'settlements.addOuterBeyondTech' : 'settlements.addOuter',
				{ settlement: d.id, x: tile.x, y: tile.y },
				privileged,
			);
			return d.nextOuter;
		};
		expect(await addOuter()).toBeTruthy();
		await addOuter(); // 3 = research limit
		expect((await p.detail(T0)).nextOuter!.blocked).toBe('Research more to build more outer cities');
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
		const d = await p.detail(T0 + 30_000);
		const near = d.nextOuter!.candidates[0];
		expect(d.terrain![`${near.x},${near.y}`]).toMatchObject({ terrain: expect.any(String) });
		expect(d.terrain![`${o.x},${o.y}`]).toMatchObject({ terrain: 'forest', bonus: { wood: 30 } });
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
		expect((await p.pool(at)).factor).toBeCloseTo(1.08);
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
		// The same for the generic widgets: the queue, what this institute researches, what it can start.
		const shown = (await p.views(t1, ['research.queue', 'research.current', 'research.options'])) as {
			'research.queue': TimersData;
			'research.current': TimersData;
			'research.options': CardsData;
		};
		expect(shown['research.queue'].items).toEqual([
			expect.objectContaining({ title: { text: '{tech} {n}', vars: { tech: 'Treasury', n: 1 } }, endsAt: expect.any(Number) }),
		]);
		expect(shown['research.current'].items).toHaveLength(1);
		// Cards like the tree's, one branch and tier at a time (the first by default).
		const options = shown['research.options'];
		expect(options.defaultGroup).toBe(options.groups![0].id);
		const agri = options.cards.find((r) => r.id === 'agriculture')!;
		expect(agri).toMatchObject({ group: 'Civil|1', badge: { text: 'Lv {n}/{max}' } });
		expect(agri.actions![0]).toMatchObject({ command: 'research.start', blocked: { text: 'This settlement is already researching' } });
		expect(agri.lines).toContainEqual(
			expect.objectContaining({ text: expect.objectContaining({ text: '{building} levels {from}–{to}' }) }),
		);

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

	const SURE = {
		'starter-items.chances': {
			'land-grant': { base: 1, rate: 0 },
			'breakthrough-stone': { base: 1, rate: 0 },
			'expansion-permit': { base: 1, rate: 0 },
			'city-charter': { base: 1, rate: 0 },
			'resource-fortress-charter': { base: 1, rate: 0 },
		},
	};

	it('appear as forms only while owned, and are consumed atomically with their effect', async () => {
		const p = player({ 'player-settlements.outerCost': { food: 0 }, ...SURE });
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

	it("expansion permits raise the outer-city quota; breakthrough stones raise one building's cap", async () => {
		const p = player({ 'settlements.outerTechLimit': 1, 'buildings.rules': { farm: { cap: 1 } }, ...SURE });
		const c = await p.start();
		expect((await p.detail(T0)).nextOuter!.blocked).toMatch(/Research more/);
		await p.run(T0, 'items.grant', { item: 'expansion-permit', count: 1 }, true);
		await p.run(T0, 'items.use.expansion-permit', { settlement: c.id });
		const d = await p.detail(T0);
		expect(d.limits.outerTech).toBe(2);
		expect(d.nextOuter!.blocked).toBeUndefined();
		await p.run(T0, 'settlements.addOuter', { settlement: c.id, ...d.nextOuter!.candidates[0] });

		await p.construct(T0, c.id, outer(c).id, 0, 'farm');
		await p.run(T0 + 20_000, 'items.grant', { item: 'breakthrough-stone', count: 1 }, true);
		await p.run(T0 + 20_000, 'items.use.breakthrough-stone', { settlement: c.id, target: `${outer(c).id}:0` });
		expect(outer(await p.detail(T0 + 20_000)).slots[0].current!.cap).toBe(2);
		expect((await inbox(p, T0 + 20_000)).messages.map((m) => m.title)).toContain('{item} worked: {what}');
	});

	it('show on the Items page as generic tiles: by category, opening one gives its use form', async () => {
		const p = player();
		await p.start();
		const cards = async () => (await p.views(T0, ['items.cards']))['items.cards'] as CardsData;
		expect((await cards()).cards).toEqual([]);
		await p.run(T0, 'items.grant', { item: 'land-grant', count: 2 }, true);
		await p.run(T0, 'items.grant', { item: 'realm-key-soul-valley', count: 1 }, true);
		const d = await cards();
		expect(d.groups!.map((g) => g.id)).toEqual(['building', 'keys']);
		expect(d.cards.find((c) => c.id === 'land-grant')).toMatchObject({
			group: 'building',
			count: 2,
			detail: { form: { placement: 'items', command: 'items.use.land-grant' } },
		});
		// A key exchanges for resources: usable too.
		expect(d.cards.find((c) => c.id === 'realm-key-soul-valley')!.detail!.form).toEqual({
			placement: 'items',
			command: 'items.use.realm-key-soul-valley',
		});
	});

	it('cities start at none: three techs and city charters raise the limit, never past the hard limit', async () => {
		const p = player({ 'player-settlements.limits': { city: 0 }, 'player-settlements.limitMax': { city: 4 } });
		const c = await p.start();
		const limit = async (now = T0) => {
			const f = ((await p.views(now, ['ui.forms'], { placement: 'items', settlement: c.id }))['ui.forms'] as ResolvedForm[]).find(
				(x) => x.command === 'items.use.city-charter',
			);
			return f?.description;
		};
		expect(await limit()).toBeUndefined(); // no charter yet
		await p.run(T0, 'items.grant', { item: 'city-charter', count: 1 }, true);
		expect(await limit()).toMatch(/^Limit \(City\): 0\/4 · pity 0\/2/); // 50%: sure by the 2nd try
		for (const tech of ['frontier-towns', 'circuits', 'provinces']) await p.run(T0, 'research.setLevel', { tech, level: 1 }, true);
		expect(await limit()).toMatch(/^Limit \(City\): 3\/4 · pity 0\/2/); // n counts charters only, not techs
		// A sure charter adds one; at the hard limit the next is refused and kept.
		const sure = player({ 'player-settlements.limits': { city: 3 }, 'player-settlements.limitMax': { city: 4 }, ...SURE });
		await sure.start();
		await sure.run(T0, 'items.grant', { item: 'city-charter', count: 2 }, true);
		await sure.run(T0, 'items.use.city-charter', null);
		await expect(sure.run(T0, 'items.use.city-charter', null)).rejects.toThrow(/Limit reached: City/);
		expect((await inbox(sure, T0)).messages.map((m) => m.title)).toContain('{item} worked: {what}');
	});

	it('fortresses start at none too: tech milestones, a late tech a level, and charters with no limit', async () => {
		const p = player({ 'player-settlements.limits': { 'fortress-resource': 0 }, ...SURE });
		const c = await p.start();
		const limit = async () =>
			((await p.views(T0, ['ui.forms'], { placement: 'items', settlement: c.id }))['ui.forms'] as ResolvedForm[]).find(
				(x) => x.command === 'items.use.resource-fortress-charter',
			)?.description;
		await p.run(T0, 'items.grant', { item: 'resource-fortress-charter', count: 1 }, true);
		expect(await limit()).toMatch(/^Limit \(Resource fortress\): 0 · /);
		// A milestone counts once, from its level on (agriculture: at 3).
		await p.run(T0, 'research.setLevel', { tech: 'agriculture', level: 2 }, true);
		expect(await limit()).toMatch(/: 0 · /);
		await p.run(T0, 'research.setLevel', { tech: 'agriculture', level: 3 }, true);
		expect(await limit()).toMatch(/: 1 · /);
		// The late tech: one a level. The military limit is separate.
		await p.run(T0, 'research.setLevel', { tech: 'crown-estates', level: 4 }, true);
		expect(await limit()).toMatch(/: 5 · /);
		await p.run(T0, 'items.use.resource-fortress-charter', null);
		await p.run(T0, 'items.grant', { item: 'military-fortress-charter', count: 1 }, true);
		const forms = (await p.views(T0, ['ui.forms'], { placement: 'items', settlement: c.id }))['ui.forms'] as ResolvedForm[];
		expect(forms.find((x) => x.command === 'items.use.military-fortress-charter')?.description).toMatch(
			/^Limit \(Military fortress\): 0 · /,
		);
		expect(await limit()).toBeUndefined(); // used up, but it worked:
		expect((await inbox(p, T0)).messages.map((m) => m.title)).toContain('{item} worked: {what}');
	});

	it('an edict for talent raises the hero limit for good; it shows up where heroes are recruited, with where to get it', async () => {
		const p = player({ 'buildings.speed': 1e6 });
		await p.start();
		const capOf = async () => {
			const svc = defaultKernel.services.get('stats');
			return svc.get(
				{
					...engineContext(defaultKernel, p.id, T0),
					db,
					services: defaultKernel.services,
					memo: (_k: string, l: () => Promise<unknown>) => l(),
				} as never,
				'heroes.cap',
				`player:${p.id}`,
			);
		};
		const before = await capOf();
		await p.run(T0, 'items.grant', { item: 'recruit-edict', count: 2 }, true);
		await p.run(T0, 'items.use.recruit-edict', null);
		await p.run(T0, 'items.use.recruit-edict', null);
		expect(await capOf()).toBe(before + 2);
		const meta = (defaultKernel.meta.get('items')!() as { id: string; shortcuts: string[]; sources: string[] }[]).find(
			(i) => i.id === 'recruit-edict',
		)!;
		expect(meta.shortcuts).toEqual(expect.arrayContaining(['building:tavern', 'page:heroes']));
		expect(meta.sources).toEqual(expect.arrayContaining(['shop', 'realms']));
		// The same as compact cards: one per place; none left, so where to get it and a way to the shop.
		const shortcuts = ((await p.views(T0, ['items.shortcuts']))['items.shortcuts'] as CardsData).cards.filter((c) =>
			c.id.startsWith('recruit-edict@'),
		);
		expect(shortcuts.map((c) => c.where)).toEqual(expect.arrayContaining(['building:tavern', 'page:heroes']));
		expect(shortcuts[0]).toMatchObject({ count: 0, actions: [{ page: 'shop' }] });
		await p.run(T0, 'items.grant', { item: 'recruit-edict', count: 1 }, true);
		const owned = ((await p.views(T0, ['items.shortcuts']))['items.shortcuts'] as CardsData).cards.find(
			(c) => c.id === 'recruit-edict@page:heroes',
		)!;
		expect(owned).toMatchObject({ count: 1, detail: { form: { placement: 'items', command: 'items.use.recruit-edict' } } });
	});

	it('"may raise" items fail by chance (the item is used up), count failures and always work after the pity limit', async () => {
		const p = player({ 'starter-items.chances': { 'land-grant': { base: 0, pity: 3 } }, 'starter-items.pity': { days: 1 } });
		const c = await p.start();
		await p.run(T0, 'items.grant', { item: 'land-grant', count: 6 }, true);
		const slots = () => p.detail(T0).then((d) => outer(d).slots.length);
		const before = await slots();
		const label = async () =>
			((await p.views(T0, ['ui.forms'], { placement: 'items', settlement: c.id }))['ui.forms'] as ResolvedForm[])
				.find((f) => f.command === 'items.use.land-grant')!
				.fields.find((f) => f.name === 'district')!.options![0].label;
		// Players see the pity progress only; the GM also sees the chance.
		expect(await label()).toMatch(/· pity 0\/3$/);
		expect(await label()).not.toMatch(/%/);
		const asGm = (
			await computeViews(
				defaultKernel,
				db,
				engineContext(defaultKernel, p.id, T0, { 'starter-items.chances': { 'land-grant': { base: 0, pity: 3 } } }, true),
				['ui.forms'],
				{ placement: 'items', settlement: c.id },
			)
		).views['ui.forms'] as ResolvedForm[];
		expect(asGm.find((f) => f.command === 'items.use.land-grant')!.fields.find((f) => f.name === 'district')!.options![0].label).toMatch(
			/0% · pity 0\/3$/,
		);
		// Pity 3: two failures, then the third try is sure.
		for (let i = 0; i < 2; i++) await p.run(T0, 'items.use.land-grant', { settlement: c.id, district: outer(c).id });
		expect(await slots()).toBe(before);
		expect(await label()).toMatch(/pity 2\/3$/);
		await p.run(T0, 'items.use.land-grant', { settlement: c.id, district: outer(c).id }); // the pity use
		expect(await slots()).toBe(before + 1);
		expect(await label()).toMatch(/pity 0\/3$/);
		// Failures are forgotten after the pity window (a day here).
		await p.run(T0, 'items.use.land-grant', { settlement: c.id, district: outer(c).id });
		expect(await label()).toMatch(/pity 1\/3$/);
		const later = (
			(await p.views(T0 + 2 * 86_400_000, ['ui.forms'], { placement: 'items', settlement: c.id }))['ui.forms'] as ResolvedForm[]
		).find((f) => f.command === 'items.use.land-grant')!;
		expect(later.fields.find((f) => f.name === 'district')!.options![0].label).toMatch(/pity 0\/3$/);
		const titles = (await inbox(p, T0)).messages.map((m) => m.title);
		expect(titles.filter((t) => t.startsWith('{item} failed'))).toHaveLength(3);
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
		expect((await garrison(p, T0 + 40_000)).training).toEqual([expect.objectContaining({ unit: 'militia', count: 5 })]);

		const g = await garrison(p, T0 + 60_000);
		expect(g.units).toEqual([{ id: 'militia', count: 5 }]);
		// The Army page's rows: one section per settlement (selectable), a row per unit, then upkeep.
		const rows = (await p.views(T0 + 60_000, ['troops.garrisons']))['troops.garrisons'] as RowsData;
		expect(rows.sections[0]).toMatchObject({
			current: true,
			actions: [{ params: { settlement: c.id } }],
			rows: [{ id: 'militia', title: { vars: { n: '5' } } }],
		});
		expect(rows.sections[0].lines).toContainEqual(expect.objectContaining({ text: expect.objectContaining({ text: 'Upkeep: {list}/h' }) }));
		expect(g.upkeep.food).toBeCloseTo(0.1);
		const pool = await p.pool(T0 + 60_000);
		expect(pool.upkeep.food).toBeCloseTo(0.1);
		// 500 - 200 (barracks) - 150 (militia) - 0.1/s for the 5 s since they arrived.
		expect(pool.amounts.food).toBeCloseTo(150 - 0.5);
	});

	it('queue training plans per barracks: paid at once, started in turn, cancelled for a full refund until they start', async () => {
		const p = player({ 'buildings.speed': 1e6 });
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'barracks');
		await p.construct(T0, c.id, inner(c).id, 1, 'archer-camp');
		for (const r of ['food', 'wood', 'stone', 'metal', 'gold']) await p.grant(T0 + 1_000, r, 100_000);
		const t = T0 + 1_000;
		const stock = async (now = t) => Object.values((await p.pool(now)).amounts).reduce((a, b) => a + b, 0);
		const before = await stock();
		await p.run(t, 'troops.train', { settlement: c.id, unit: 'infantry-1', count: 10 });
		const paidOne = before - (await stock());
		await p.run(t, 'troops.train', { settlement: c.id, unit: 'infantry-1', count: 10 }); // waits: same barracks
		await p.run(t, 'troops.train', { settlement: c.id, unit: 'archer-1', count: 10 }); // its own barracks: starts now
		// Every plan is paid when added, the waiting one too.
		expect(before - (await stock())).toBeGreaterThan(paidOne * 2);
		let q = (await garrison(p, t)).training;
		expect(q.map((b) => [b.unit, b.startedAt !== null])).toEqual([
			['infantry-1', true],
			['infantry-1', false],
			['archer-1', true],
		]);
		// A plan that has not started can be cancelled: the cost comes back (and the prestige it gave goes).
		const prestige = async () => ((await p.views(t, ['prestige.status']))['prestige.status'] as PrestigeStatus).value;
		const prestigeBefore = await prestige();
		const beforeCancel = await stock();
		await p.run(t, 'troops.cancel', { settlement: c.id, id: q[1].id });
		expect((await stock()) - beforeCancel).toBeCloseTo(paidOne, 3);
		expect(await prestige()).toBeCloseTo(prestigeBefore - paidOne / 1000, 6);
		await expect(p.run(t, 'troops.cancel', { settlement: c.id, id: q[0].id })).rejects.toThrow(/already training/);
		// Queue another; when the first is done, it starts by itself at that moment.
		await p.run(t, 'troops.train', { settlement: c.id, unit: 'infantry-1', count: 5 });
		const firstDone = (await garrison(p, t)).training[0].finishesAt!;
		const g = await garrison(p, firstDone + 1);
		expect(g.units).toEqual(expect.arrayContaining([{ id: 'infantry-1', count: 10 }]));
		q = g.training.filter((b) => b.unit === 'infantry-1');
		expect(q).toEqual([expect.objectContaining({ count: 5, startedAt: firstDone })]);
		// The same as generic timers for the barracks' entries (each line says which barracks).
		await p.run(firstDone + 1, 'troops.train', { settlement: c.id, unit: 'infantry-1', count: 3 });
		const timers = (await p.views(firstDone + 1, ['troops.training']))['troops.training'] as TimersData;
		const infantry = timers.items.filter((i) => i.where === 'barracks');
		expect(infantry[0]).toMatchObject({ startedAt: firstDone, endsAt: expect.any(Number), title: { vars: { n: 5 } } });
		expect(infantry[1].actions![0]).toMatchObject({ command: 'troops.cancel', payload: { settlement: c.id, id: infantry[1].id } });
		expect(timers.notes).toContainEqual(expect.objectContaining({ where: 'barracks' }));
		expect(timers.notes).toContainEqual({ where: 'cavalry-camp', text: { text: expect.stringMatching(/Requires/) }, tone: 'muted' });
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
			expect.objectContaining({ settlement: c.id, training: [expect.objectContaining({ unit: 'infantry-1', count: 2 })] }),
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

	it('levy orders: tier 2-4 training takes quota (1000 / 100 per order), spent for good', async () => {
		const p = player({ 'buildings.speed': 1e6 });
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'barracks');
		const at = T0 + 1_000;
		await p.run(at, 'buildings.setLevel', { settlement: c.id, district: inner(c).id, slot: 0, level: 10 }, true);
		for (const r of ['food', 'wood', 'metal', 'stone', 'gold']) await p.grant(at, r, 100_000);
		await p.run(at, 'troops.train', { settlement: c.id, unit: 'infantry-1', count: 5 }); // tier 1: free of quota
		const t = at + 3_600_000;
		await expect(p.run(t, 'troops.train', { settlement: c.id, unit: 'infantry-2', count: 5 })).rejects.toThrow(/levy quota: 0 left/);
		await p.run(t, 'items.grant', { item: 'levy-infantry-2', count: 1 }, true);
		await p.run(t, 'items.use.levy-infantry-2', null);
		await p.run(t, 'troops.train', { settlement: c.id, unit: 'infantry-2', count: 5 });
		const form = ((await p.views(t, ['ui.forms'], { placement: 'items', settlement: c.id }))['ui.forms'] as ResolvedForm[]).find(
			(f) => f.command === 'items.use.levy-infantry-2',
		);
		expect(form).toBeUndefined(); // used up
		await p.run(t, 'items.grant', { item: 'levy-infantry-3', count: 1 }, true);
		const f3 = ((await p.views(t, ['ui.forms'], { placement: 'items', settlement: c.id }))['ui.forms'] as ResolvedForm[]).find(
			(f) => f.command === 'items.use.levy-infantry-3',
		)!;
		expect(f3.description).toMatch(/Quota now: 0/);
		await p.run(t, 'items.use.levy-infantry-3', null);
		await expect(p.run(t + 3_600_000, 'troops.train', { settlement: c.id, unit: 'infantry-3', count: 101 })).rejects.toThrow(/100 left/);
		// In the shop.
		expect(((await p.views(t, ['shop.store']))['shop.store'] as ShopStore).offers.find((o) => o.id === 'levy-infantry-2')).toMatchObject({
			price: 30,
		});
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
		await p.run(at, 'starter-levies.grant', { unit: 'infantry-2', quota: 10 }, true); // the levy plugin's own requirement
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

describe('mailbox paging', () => {
	it('pages by 30 without skipping messages sent at the same moment', async () => {
		const mailer = definePlugin({
			id: 'test-mailer',
			version: '0',
			dependsOn: ['mail'],
			setup(ctx) {
				ctx.commands.add<number>({
					type: 'test-mailer.send',
					parse: (raw) => Number(raw),
					async execute(api, n) {
						for (let i = 0; i < n; i++) ctx.services.get('mail').send(api, api.playerId, { kind: 'test', title: `#${i}` });
					},
				});
			},
		});
		const p = player({}, createKernel([...plugins, mailer]));
		await p.run(T0, 'test-mailer.send', 70); // all at T0
		const seen = new Set<string>();
		let params: Record<string, string> = {};
		const sizes: number[] = [];
		for (;;) {
			const box = (await p.views(T0, ['mail.inbox'], params))['mail.inbox'] as MailInbox;
			sizes.push(box.messages.length);
			for (const m of box.messages) seen.add(m.id);
			if (!box.more) break;
			const last = box.messages[box.messages.length - 1];
			params = { mailBefore: String(last.at), mailBeforeId: last.id };
		}
		expect(sizes).toEqual([30, 30, 10]);
		expect(seen.size).toBe(70);
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
		expect(techs.filter((t) => t.branch === 'Civil')).toHaveLength(24);
		expect(techs.filter((t) => t.branch === 'Military')).toHaveLength(22);
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
		expect(byId.get('art-of-war')!.effects).toEqual([
			{ target: 'battle.attack', value: 2.5, percent: true },
			// Milestones: once, at that level.
			{ target: 'settlements.limit.fortress-military', value: 1, percent: false, atLevel: 5 },
			{ target: 'settlements.limit.fortress-military', value: 1, percent: false, atLevel: 10 },
		]);
		expect(byId.get('drill')!.effects).toContainEqual({ target: 'time.training', value: -4, percent: true });
		expect(byId.get('regiments')!.unlocks).toEqual([{ building: 'barracks', from: 6, perLevel: 5 }]);
		// The same as a generic tree: branches of four tiers; prerequisites in the branch as lines, the others as tags.
		const graph = (await p.views(T0, ['research.graph']))['research.graph'] as TreeData;
		// (Other tests add runtime nodes outside the branches, as group "Other".)
		expect(graph.groups.filter((g) => g.id !== 'Other').map((g) => [g.id, g.columns.length])).toEqual([
			['Civil', 4],
			['Military', 4],
		]);
		const nodes = graph.groups.flatMap((g) => g.columns.flatMap((c) => c.nodes));
		expect(nodes.find((n) => n.id === 'irrigation')).toMatchObject({
			state: 'locked',
			requires: [{ id: 'agriculture', met: false }],
			tags: [],
		});
		expect(nodes.find((n) => n.id === 'military-farms')!.tags).toEqual([
			{ text: { text: '{tech} {n}', vars: { tech: 'Art of War', n: 1 } }, met: false },
		]);
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
		expect(after.food).toBeCloseTo(before.food * 1.06); // +3% a level, food only
		expect(after.wood).toBeCloseTo(before.wood);

		const seconds = async () =>
			((await p.views(at, ['troops.garrison']))['troops.garrison'] as GarrisonInfo).trainable.find((t) => t.unit === 'infantry-1')!.seconds;
		const base = await seconds();
		await p.run(at, 'research.setLevel', { tech: 'drill', level: 5 }, true);
		expect(await seconds()).toBeLessThan(base); // 20% faster (rounded up to whole seconds)

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
				{ source: 'Art of War', stat: 'attack', percent: 5 },
				{ source: 'Foot Armour', stat: 'hp', percent: 3 },
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

	it('reach the other systems through their stats and hooks: caps, terrain, candidates, cargo, speed, scouts, walls, promotions', async () => {
		const rules = { 'armies.minSeconds': 0, 'buildings.speed': 1e6, 'pvp.protectionHours': 0 };
		const p = player(rules);
		const c = await p.start();
		const o = outer(c);
		await p.construct(T0, c.id, o.id, 0, 'farm');
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		let t = T0 + 2_000;
		const set = (tech: string, level: number, who = p) => who.run(t, 'research.setLevel', { tech, level }, true);

		// Building caps: Works of Heaven, +2 levels a level on resource buildings.
		const farmCap = async () => outer(await p.detail(t)).slots[0].current!.cap;
		expect(await farmCap()).toBe(20);
		await set('works-of-heaven', 2);
		expect(await farmCap()).toBe(24);

		// Terrain: irrigation adds food everywhere, and again on rivers.
		await p.run(t, 'terrain.paint', { x: o.x, y: o.y, width: 1, height: 1, terrain: 'river' }, true);
		const food = async () => (await p.pool(t)).rates.food;
		expect(await food()).toBeCloseTo(1);
		await set('irrigation', 1);
		expect(await food()).toBeCloseTo(1.06);

		// More hero candidates.
		const offered = async () =>
			((await p.views(t, ['heroes.candidates']))['heroes.candidates'] as HeroCandidates[]).find((v) => v.venue === 'tavern')!.candidates
				.length;
		const before = await offered();
		await set('examinations', 1);
		expect(await offered()).toBe(before + 1);

		// Supplies for transfers: +8% of the units' carry.
		await p.run(t, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 10 }, true);
		const fort = { x: wrap(c.x + 6), y: c.y };
		await p.run(t, 'settlements.found', { kind: 'fortress-military', ...fort }, true);
		const capacity = async () =>
			((await p.views(t, ['ui.forms'], { placement: 'tile', x: String(fort.x), y: String(fort.y) }))['ui.forms'] as ResolvedForm[]).find(
				(f) => f.command === 'armies.transfer',
			)!.budgets![0].capacity['units.infantry-1'];
		expect(await capacity()).toBeCloseTo(20);
		await set('grain-canals', 1);
		expect(await capacity()).toBeCloseTo(21.6);

		// March speed: post roads, +6% at level 2.
		const trip = async () => {
			await p.run(t, 'armies.send', { from: c.id, x: wrap(c.x + 40), y: c.y, units: { 'infantry-1': 1 } });
			const army = ((await p.views(t, ['armies.list']))['armies.list'] as ArmyInfo[]).find((a) => a.departedAt === t)!;
			return army.arrivesAt - t;
		};
		const slow = await trip();
		t += 1_000;
		await set('post-roads', 2);
		expect((await trip()) / 1000).toBeCloseTo(Math.ceil(slow / 1000 / 1.06), 0);

		// Walls and scouts, in a real attack: the defender's fortification strengthens the wall,
		// the attacker's firearms cut its bonus, the defender's scouts see what comes.
		const q = player(rules);
		const cq = await q.start();
		const wall = inner(await p.detail(t)).slots.find((x) => x.current?.building === 'wall')!;
		await p.run(t, 'buildings.setLevel', { settlement: c.id, district: inner(c).id, slot: wall.slot, level: 10 }, true);
		await set('fortification', 2);
		await set('scouts', 3);
		await set('firearms', 1, q);
		await q.run(t, 'troops.grant', { settlement: cq.id, unit: 'cavalry-1', count: 10 }, true);
		await q.run(t, 'armies.send', { from: cq.id, x: c.x, y: c.y, units: { 'cavalry-1': 10 } });
		const incoming = (await p.views(t, ['armies.incoming']))['armies.incoming'] as IncomingArmy[];
		expect(incoming[0].intel).toEqual({ level: 3, total: 10, units: { 'cavalry-1': 10 } });
		const attack = ((await q.views(t, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await q.run(attack.arrivesAt, 'timeline.sync', { entity: `army:${attack.id}` }, true);
		const report = ((await q.views(attack.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		// Level 10: 100 a level x 120%, and its 10% bonus less the attacker's 3 points.
		expect(report.battle!.modifiers.defender).toContainEqual({ source: 'Wall Lv 10', stat: 'defense', flat: 1200, percent: 7 });

		// Promotions cost less quota (Royal Army: battle.promotionCost -10%): the formula takes the factor.
		const battle = defaultKernel.services.get('battle');
		expect(battle.promotions({ 'infantry-1': 30 }, { 'infantry-1': 10 })).toEqual([{ from: 'infantry-1', to: 'infantry-2', count: 10 }]);
		expect(battle.promotions({ 'infantry-1': 30 }, { 'infantry-1': 10 }, 2)).toEqual([{ from: 'infantry-1', to: 'infantry-2', count: 5 }]);
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
				'npc-camps.levels': { 'npc-fortress': { 1: { stockade: 1e6, lane: { 3: 240 } } } },
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
		expect(widget).toMatchObject({ type: 'widget', widget: 'ui.lanes-input' });
		const data = widget.data as LanesInputData;
		expect(data).toMatchObject({
			lanes: 5,
			poolField: 'from',
			output: { lanes: 'formation', group: 'family', counts: 'units', total: 'units' },
		});
		expect(data.pools[c.id]).toEqual({ 'infantry-1': 10, militia: 3 });
		expect(data.options).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: 'infantry-1', group: 'infantry', order: 1 }),
				expect.objectContaining({ id: 'militia', group: null }),
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

	it('transport resources to a settlement, or fetch them from one (a resource fortress holds no troops)', async () => {
		const p = player(fast, unitsKernel);
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'militia', count: 10 }, true);
		const resTile = await freeNear(c, 4);
		await p.run(T0, 'settlements.found', { kind: 'fortress-resource', ...resTile, name: 'Mine' }, true);
		const mineId = (await p.mine(T0)).find((s) => s.name === 'Mine')!.id;
		const forms = (
			(await p.views(T0, ['ui.forms'], { placement: 'tile', x: String(resTile.x), y: String(resTile.y) }))['ui.forms'] as ResolvedForm[]
		).map((f) => f.command);
		expect(forms).toEqual(expect.arrayContaining(['armies.transportTo', 'armies.transportBack', 'armies.transfer']));

		// To: unload there and come back.
		await p.run(T0, 'armies.transportTo', { from: c.id, ...resTile, units: { militia: 2 }, cargo: { stone: 30 } });
		const to = (await armies(p, T0))[0];
		expect(to.mission).toBe('transport');
		const mineStone = (await p.pool(T0, mineId)).amounts.stone;
		await p.run(to.arrivesAt, 'timeline.sync', { entity: `army:${to.id}` }, true);
		expect((await p.pool(to.arrivesAt, mineId)).amounts.stone).toBeCloseTo(mineStone + 30);
		expect((await armies(p, to.arrivesAt))[0]).toMatchObject({ phase: 'returning', loot: {} });

		// Back: leave empty, bring home what was asked for, at most what the units carry (4 militia: 80).
		await expect(p.run(T0, 'armies.transportBack', { from: c.id, ...resTile, units: { militia: 4 }, cargo: { wood: 1 } })).rejects.toThrow(
			/leaves empty/,
		);
		await p.grant(T0, 'food', 1000, mineId);
		await p.run(T0, 'armies.transportBack', { from: c.id, ...resTile, units: { militia: 4 }, 'pickup.food': 60, 'pickup.wood': 60 });
		const back = (await armies(p, T0)).find((a) => a.id !== to.id)!;
		const before = (await p.pool(back.arrivesAt, mineId)).amounts;
		await p.run(back.arrivesAt, 'timeline.sync', { entity: `army:${back.id}` }, true);
		const after = (await p.pool(back.arrivesAt, mineId)).amounts;
		expect(before.food - after.food).toBeCloseTo(40, 0); // 120 asked, 80 carried: scaled evenly
		expect(before.wood - after.wood).toBeCloseTo(40, 0);
		const home = (await p.pool(back.returnsAt)).amounts.food;
		await p.run(back.returnsAt, 'timeline.sync', { entity: `army:${back.id}` }, true);
		expect((await p.pool(back.returnsAt)).amounts.food).toBeCloseTo(home + 40, 0);
		await expect(p.run(T0, 'armies.transportTo', { from: c.id, x: wrap(c.x + 30), y: c.y, units: { militia: 1 } })).rejects.toThrow(
			/your own settlements/,
		);
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
		// The clients act on time: the attacker's commits the arrival, the defender's refreshes.
		expect(((await a.views(T0, ['armies.due']))['armies.due'] as SyncData).items).toEqual([{ at: army.arrivesAt, command: 'armies.sync' }]);
		expect(((await b.views(T0, ['armies.due']))['armies.due'] as SyncData).items).toEqual([{ at: army.arrivesAt }]);
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
		// Shown as generic reports: each side sees the lanes from its own side.
		const march = (await inbox(a, army.arrivesAt)).messages[0].report!;
		expect(march).toMatchObject({ tone: 'good', badge: { text: 'mission:attack' } });
		expect(march.fields?.map((f) => f.label.text)).toContain('Enemy losses');
		expect(march.lanes?.rows).toHaveLength(5);
		// Each side's lane: its family and total, then unit by unit.
		expect(march.lanes?.rows[0].cells[0][1].text).toEqual({
			text: '{0}',
			vars: { 0: [{ text: '{0} ×{1}', vars: { 0: 'Light Horse (Cavalry)', 1: '40' } }] },
		});
		expect(march.lanes?.rows.map((r) => r.tone)).toEqual(report.battle!.lanes.map((l) => (l.winner === 'attacker' ? 'good' : 'bad')));
		const defense = (await inbox(b, army.arrivesAt)).messages[0].report!;
		expect(defense.tone).toBe('bad');
		expect(defense.lanes?.rows.map((r) => r.tone)).toEqual(report.battle!.lanes.map((l) => (l.winner === 'defender' ? 'good' : 'bad')));
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
		// Empty attacking lanes: no attack. Archers counter cavalry, but counters multiply only what
		// troops bring: an empty lane's wall defence stays 100.
		expect(battle!.lanes[1]).toMatchObject({ winner: 'defender', attacker: { attack: 0, counters: true }, defender: { defense: 100 } });
		expect(battle!.lanes[2]).toMatchObject({ winner: 'defender', defender: { defense: 100, counters: true } });
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

	it('auxiliaries: surgeons save part of the fallen, carts carry the slowest units, the supply depot trains them', async () => {
		// Training needs the depot (carts a higher level).
		const t = player({ 'buildings.speed': 1e6 });
		const ct = await t.start();
		const trainable = async () => ((await t.views(T0 + 1_000, ['troops.garrison']))['troops.garrison'] as GarrisonInfo).trainable;
		await t.construct(T0, ct.id, inner(ct).id, 0, 'supply-depot');
		expect((await trainable()).find((u) => u.unit === 'field-surgeon')?.blocked).toBeUndefined();
		expect((await trainable()).find((u) => u.unit === 'mule-cart')?.blocked).toBe('Requires Supply Depot Lv 3');

		// Surgeons: the same battle with and without them.
		const fight = async (surgeons: number) => {
			const fast = { 'armies.speed': 1e6, 'armies.minSeconds': 0, 'pvp.protectionHours': 0 };
			const a = player(fast);
			const b = player(fast);
			const ca = await a.start();
			const cb = await b.start();
			await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'infantry-1', count: 100 }, true);
			if (surgeons) await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'field-surgeon', count: surgeons }, true);
			await b.run(T0, 'troops.grant', { settlement: cb.id, unit: 'cavalry-1', count: 300 }, true);
			await b.run(T0, 'battle.setFormation', { settlement: cb.id, lanes: ['cavalry', 'infantry', 'archer', 'archer', 'archer'] });
			const empty = { family: 'cavalry', units: {} };
			await a.run(T0, 'armies.send', {
				from: ca.id,
				x: cb.x,
				y: cb.y,
				units: { 'infantry-1': 100, ...(surgeons ? { 'field-surgeon': surgeons } : {}) },
				formation: [{ family: 'infantry', units: { 'infantry-1': 100 } }, empty, empty, empty, empty],
			});
			const army = ((await a.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
			await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
			return ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		};
		const plain = (await fight(0)).losses.attacker['infantry-1'];
		expect(plain).toBeGreaterThan(10);
		const helped = await fight(50); // 100 saves asked, capped at 30% of the losses
		expect(helped.losses.attacker['infantry-1']).toBe(plain - Math.floor(plain * 0.3));
		expect(helped.losses.attacker['field-surgeon'] ?? 0).toBe(0);

		// Carts: 10 infantry ride a mule cart (150 tiles/h instead of 120); 20 do not all fit.
		const p = player({ 'armies.minSeconds': 0 });
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 40 }, true);
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'mule-cart', count: 2 }, true);
		const trip = async (units: Record<string, number>) => {
			await p.run(T0, 'armies.send', { from: c.id, x: wrap(c.x + 60), y: c.y, units });
			const list = (await p.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[];
			const army = list[list.length - 1];
			await p.run(T0, 'armies.recall', { id: army.id });
			return (army.arrivesAt - T0) / 1000;
		};
		const walk = await trip({ 'infantry-1': 10 });
		expect(walk).toBe(Math.ceil((60 / 120) * 3600));
		expect(await trip({ 'infantry-1': 10, 'mule-cart': 1 })).toBe(Math.ceil((60 / 150) * 3600));
		expect(await trip({ 'infantry-1': 11, 'mule-cart': 1 })).toBe(walk); // one walks
	});

	it('flat hp (siege defences) takes damage before the troops: fewer of them fall', async () => {
		const losses = async (buffer: number) => {
			const plugin = definePlugin({
				id: 'test-buffer',
				version: '0',
				dependsOn: ['battle'],
				setup(ctx) {
					ctx.services
						.get('battle')
						.addModifier(async (_api, side) =>
							side.role === 'defender' && buffer ? [{ source: 'Buffer', stat: 'hp', flat: buffer }] : [],
						);
				},
			});
			const fast = { 'armies.speed': 1e6, 'armies.minSeconds': 0, 'pvp.protectionHours': 0 };
			const k = createKernel([...plugins, plugin]);
			const a = player(fast, k);
			const b = player(fast, k);
			const ca = await a.start();
			const cb = await b.start();
			await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'infantry-1', count: 150 }, true);
			await b.run(T0, 'troops.grant', { settlement: cb.id, unit: 'infantry-1', count: 100 }, true);
			await b.run(T0, 'battle.setFormation', { settlement: cb.id, lanes: ['infantry', 'archer', 'cavalry', 'cavalry', 'cavalry'] });
			const empty = { family: 'archer', units: {} };
			await a.run(T0, 'armies.send', {
				from: ca.id,
				x: cb.x,
				y: cb.y,
				units: { 'infantry-1': 150 },
				formation: [{ family: 'infantry', units: { 'infantry-1': 150 } }, empty, empty, empty, empty],
			});
			const army = ((await a.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
			await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
			return ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!.losses.defender['infantry-1'] ?? 0;
		};
		const plain = await losses(0);
		expect(plain).toBeGreaterThan(10);
		expect(await losses(300)).toBeLessThan(plain);
	});

	it('siege defences at the wall: works weaken attackers or strengthen the defence, defences add flat values and cost upkeep', async () => {
		const fast = { 'armies.speed': 1e6, 'armies.minSeconds': 0, 'pvp.protectionHours': 0 };
		const a = player(fast);
		const b = player(fast);
		const ca = await a.start();
		const cb = await b.start();
		const wall = async (now: number) =>
			(await b.views(now, ['starter-siege.wall'], { settlement: cb.id }))['starter-siege.wall'] as SiegeWall;
		for (const r of ['stone', 'wood', 'metal', 'gold']) await b.grant(T0, r, 50_000);
		const forms = (
			(await b.views(T0, ['ui.forms'], { placement: 'building', type: 'wall', settlement: cb.id }))['ui.forms'] as ResolvedForm[]
		).map((f) => f.command);
		expect(forms).toEqual(expect.arrayContaining(['starter-siege.build', 'starter-siege.fortify']));

		// Cost from value (r = 1 for a rockfall platform): 100 split 35 / 35 / 20 / 10, 30 s each.
		const stone = (await b.pool(T0)).amounts.stone;
		await b.run(T0, 'starter-siege.build', { settlement: cb.id, device: 'rock-drop', count: 5 });
		expect((await b.pool(T0)).amounts.stone).toBeCloseTo(stone - 5 * 35);
		await expect(b.run(T0, 'starter-siege.fortify', { settlement: cb.id, work: 'moat' })).rejects.toThrow(/already being built/);
		await expect(b.run(T0, 'starter-siege.build', { settlement: cb.id, device: 'cheval', count: 1 })).rejects.toThrow(/Requires Wall Lv 3/);
		const done = T0 + 150_000;
		expect((await wall(done)).devices.find((d) => d.id === 'rock-drop')!.count).toBe(5);
		expect((await wall(done)).upkeep.food).toBeCloseTo(5 * 1.5 * 0.4);
		expect((await b.pool(done)).upkeep.food).toBeCloseTo((5 * 1.5 * 0.4) / 3600);
		await b.run(done, 'starter-siege.fortify', { settlement: cb.id, work: 'moat' });
		expect((await wall(done + 600_000)).works.find((w) => w.id === 'moat')).toMatchObject({ level: 1, value: -4 });
		// The same for the generic widgets on the wall's entry: the queue (timers) and the works / defences (rows).
		const shown = async (now: number) =>
			(await b.views(now, ['starter-siege.queue', 'starter-siege.rows'], { settlement: cb.id })) as {
				'starter-siege.queue': TimersData | null;
				'starter-siege.rows': RowsData;
			};
		expect((await shown(done + 1))['starter-siege.queue']!.items[0]).toMatchObject({
			title: { vars: { item: 'Moat', n: 1 } },
			endsAt: done + 600_000,
		});
		const rows = (await shown(done + 600_000))['starter-siege.rows'];
		expect((await shown(done + 600_000))['starter-siege.queue']).toBeNull();
		expect(rows.sections[0].rows.find((r) => r.id === 'moat')).toMatchObject({ badge: { vars: { n: 1, max: 3 } } });
		expect(rows.sections[1].rows.find((r) => r.id === 'rock-drop')).toMatchObject({ title: { vars: { n: 5 } }, locked: false });
		expect(rows.sections[1].rows.find((r) => r.id === 'cheval')!.locked).toBe(true);

		// In battle: the attacker's attack -4% (moat), the defence +100 per lane (five platforms).
		const t = done + 600_000;
		await a.run(t, 'troops.grant', { settlement: ca.id, unit: 'cavalry-1', count: 10 }, true);
		await a.run(t, 'armies.send', { from: ca.id, x: cb.x, y: cb.y, units: { 'cavalry-1': 10 } });
		const army = ((await a.views(t, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		// The Army page's generic timers: the attacker's march (recallable), the defender's warning.
		const march = ((await a.views(t, ['armies.marches']))['armies.marches'] as TimersData).items[0];
		expect(march).toMatchObject({ endsAt: army.arrivesAt, actions: [{ command: 'armies.recall', payload: { id: army.id } }] });
		const alert = (await b.views(t, ['armies.alerts']))['armies.alerts'] as TimersData;
		expect(alert).toMatchObject({ tone: 'warn', items: [{ id: army.id, endsAt: army.arrivesAt }] });
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const back = ((await a.views(army.arrivesAt, ['armies.marches']))['armies.marches'] as TimersData).items[0];
		expect(back.actions).toEqual([{ page: 'mail', label: { text: 'Full report in the mailbox' } }]);
		const report = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report.battle!.modifiers.attacker).toContainEqual({ source: 'Moat Lv 1', stat: 'attack', percent: -4 });
		expect(report.battle!.modifiers.defender).toContainEqual({ source: 'Rockfall Platform ×5', stat: 'defense', flat: 100 });
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

	it('leave no resource pool behind for an army (only settlements hold resources)', async () => {
		const p = player({ 'armies.speed': 1e6, 'armies.minSeconds': 0 });
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 5 }, true);
		const at = { x: wrap(c.x + 5), y: c.y };
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...at }, true);
		await p.run(T0, 'armies.send', { from: c.id, ...at, units: { 'infantry-1': 5 } });
		const [army] = (await p.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[];
		await p.run(T0 + 5_000, 'armies.sync'); // arrives and comes back
		const row = await db
			.prepare('SELECT COUNT(*) AS n FROM resources_balances WHERE holder = ?')
			.bind(`army:${army.id}`)
			.first<{ n: number }>();
		expect(row!.n).toBe(0);
	});

	it('can be raided: outposts give food, fortresses give troops, strong defence wins', async () => {
		const p = player({
			'armies.speed': 1e6,
			'armies.minSeconds': 0,
			'npc-camps.levels': {
				'npc-outpost': { 1: { stockade: 10, lane: {} } },
				'npc-fortress': { 1: { stockade: 1e6, lane: { 1: 80 } } },
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
		// Level 1: 500 resources split evenly (no terrain bonus here), within what survivors carry.
		expect(raid.loot).toEqual({ food: 100, wood: 100, stone: 100, metal: 100, gold: 100 });
		const siege = list.find((a) => a.target.x === fortress.x)!;
		expect(siege.report?.outcome).toBe('defeat');
		expect(siege.units['cavalry-2']).toBeLessThan(25);
	});

	it('come in levels 1-10: garrison per lane by tier, stockade, loot leaning to the tile, captured units, heroes from level 3', async () => {
		// Garrisons as small as a hundredth of the data's, so 200 dragon riders can win.
		const p = player({
			'armies.speed': 1e6,
			'armies.minSeconds': 0,
			'terrain.bonus': { ...NO_TERRAIN_BONUS, forest: { wood: 30 } },
			'npc-camps.levels': {
				'npc-outpost': { 7: { lane: { 1: 50, 2: 40, 3: 20, 4: 3 } } },
				'npc-fortress': { 5: { lane: { 1: 45, 2: 22, 3: 3 } } },
			},
		});
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'cavalry-6', count: 300 }, true);
		const at = (dx: number) => ({ x: wrap(c.x + dx), y: c.y });
		await p.run(T0, 'terrain.paint', { ...at(5), width: 1, height: 1, terrain: 'forest' }, true);
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...at(5), level: 7 }, true);
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-fortress', ...at(7), level: 5 }, true);
		const camps = (await p.views(T0, ['settlements.map'], { x: String(c.x), y: String(c.y), r: '9' }))['settlements.map'] as MapTile[];
		expect(camps.find((t) => t.x === at(5).x)!.name).toBe('Rebel Granary');
		expect(camps.find((t) => t.x === at(7).x)!.name).toBe('Border Fort');
		await expect(p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...at(9), level: 11 }, true)).rejects.toThrow();

		await p.run(T0, 'armies.send', { from: c.id, ...at(5), units: { 'cavalry-6': 200 } }); // carry 30,000
		await p.run(T0, 'armies.send', { from: c.id, ...at(7), units: { 'cavalry-6': 100 } });
		const list = (await p.views(T0 + 1_500, ['armies.list']))['armies.list'] as ArmyInfo[];
		const raid = list.find((a) => a.target.x === at(5).x)!.report!;
		expect(raid.outcome).toBe('victory');
		// Level 7: 22,000 with bias 0.45 to wood (forest): wood 11% + 45% (12,320), the others 11% (2,420) each.
		expect(raid.loot).toEqual({ wood: 12320, food: 2420, stone: 2420, metal: 2420, gold: 2420 });
		// Garrison: each lane 50 / 40 / 20 / 3 of tiers 1-4; stockade 450; three heroes.
		for (const lane of raid.battle!.lanes) expect(Object.values(lane.defender.units).reduce((a, b) => a + b, 0)).toBe(113);
		expect(raid.battle!.modifiers.defender).toEqual(
			expect.arrayContaining([
				{ source: 'Stockade', stat: 'defense', flat: 450 },
				{ source: expect.stringMatching(/^Defending heroes: s:\S+ m:\S+, s:\S+ m:\S+, s:\S+ m:\S+$/), stat: 'attack', percent: 72 },
			]),
		);
		const siege = list.find((a) => a.target.x === at(7).x)!.report!;
		expect(siege.outcome).toBe('victory');
		// Level 5 fortress: 15 tier-1, 8 tier-2, 2 tier-3 captured, families at random.
		const byTier = (tier: number) =>
			Object.entries(siege.captured)
				.filter(([u]) => u.endsWith(`-${tier}`))
				.reduce((a, [, n]) => a + n, 0);
		expect([byTier(1), byTier(2), byTier(3)]).toEqual([15, 8, 2]);
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
		// The same as generic cards: a section per venue, the recruited slot marked, the other one recruitable.
		const cards = (await p.views(at, ['heroes.candidate-cards']))['heroes.candidate-cards'] as CardsData;
		expect(cards.groups?.map((g) => g.id)).toEqual(['tavern']);
		expect(cards.cards.map((x) => x.title.text)[0]).toBe('Recruited');
		expect(cards.cards[1]).toMatchObject({
			where: ['page:heroes', 'building:tavern'],
			actions: [{ command: 'heroes.recruit', payload: { settlement: c.id, venue: 'tavern', slot: 1 } }],
		});
		await expect(p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 })).rejects.toThrow(/no longer available/);
		await expect(p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 1 })).rejects.toThrow(/Hero limit/);
		// A new window brings new candidates.
		const later = (await candidates(p, at + 9 * 3600_000))[0].candidates;
		expect(later[0]).not.toBeNull();
		expect(later[0]).not.toEqual(first);

		await p.run(at, 'heroes.dismiss', { hero: hero.id });
		expect(await heroes(p, at)).toEqual([]);
	});

	it('the GM can place a candidate (chosen or rolled attributes) that the player recruits for free', async () => {
		const p = player({ 'buildings.speed': 1e6 });
		const c = await p.start();
		for (const r of ['stone', 'wood', 'food', 'gold']) await p.grant(T0, r, 5000);
		await p.construct(T0, c.id, inner(c).id, 0, 'music-house');
		const at = T0 + 1_000;
		await expect(p.run(at, 'heroes.gift', { settlement: c.id, venue: 'music-house' })).rejects.toThrow(); // GM only
		await p.run(at, 'heroes.gift', { settlement: c.id, venue: 'music-house', 'attrs.charm': 200 }, true);
		const [house] = await candidates(p, at);
		const gift = house.candidates.find((x) => x?.gift)!;
		expect(gift).toMatchObject({ gender: 'f', attrs: expect.objectContaining({ charm: 200 }) });
		const gold = (await p.pool(at)).amounts.gold;
		await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'music-house', gift: gift.gift });
		expect((await p.pool(at)).amounts.gold).toBeCloseTo(gold); // free
		expect((await heroes(p, at))[0].attrs.charm).toBe(200);
		expect((await candidates(p, at))[0].candidates.some((x) => x?.gift)).toBe(false);
		await expect(p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'music-house', gift: gift.gift })).rejects.toThrow(/no longer/);
	});

	it('grow into an army of their own: battle % and flat numbers rise with level (late game ~100%+)', async () => {
		const p = player({ 'buildings.speed': 1e6 });
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		await p.grant(T0 + 1_000, 'gold', 5000);
		await p.run(T0 + 1_000, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		const [h] = await heroes(p, T0 + 1_000);
		const at = T0 + 1_000;
		const pct = async () =>
			((await p.views(at, ['starter-heroes.roles']))['starter-heroes.roles'] as HeroRoles)[h.id].command.find((e) => e.effect === 'attack')!
				.percent;
		const fresh = await pct();
		expect(fresh).toBeGreaterThan(5);
		expect(fresh).toBeLessThan(15); // ~10% fresh
		await p.run(at, 'heroes.grantExp', { hero: h.id, exp: 2_400_000 }, true);
		const [g] = await heroes(p, at);
		expect(g.level).toBeGreaterThanOrEqual(80);
		await p.run(at, 'heroes.allocate', { hero: h.id, points: { might: g.freePoints } });
		const late = await pct();
		expect(late).toBeGreaterThan(100); // an ordinary general, every free point in might
		expect(late).toBeLessThan(400); // a high-talent roll leaning to might goes past 300%
	});

	it('roll talent totals where higher is rarer, shown on candidates', async () => {
		const p = player({ 'buildings.speed': 1e6 });
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		const totals: number[] = [];
		for (let w = 0; w < 60; w++)
			for (const cand of (await candidates(p, T0 + 1_000 + w * 9 * 3600_000))[0].candidates)
				if (cand) totals.push(Object.values(cand.talents!).reduce((a, b) => a + b, 0));
		const low = totals.filter((n) => n <= 3).length;
		const high = totals.filter((n) => n >= 6).length;
		expect(totals.every((n) => n >= 2 && n <= 7)).toBe(true);
		expect(low).toBeGreaterThan(3 * high);
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
		// The same as generic rows: the city's posts (and the defenders), and the institute's on its entry.
		const rowsOf = async (view: string) => (await p.views(at + 10_000, [view], { settlement: c.id }))[view] as RowsData;
		const city = (await rowsOf('starter-heroes.posts-city')).sections[0].rows;
		expect(city.find((r) => r.id === 'governor')).toMatchObject({ badge: { vars: { n: 1, max: 1 } } });
		expect(city.map((r) => r.id)).not.toContain('scholar');
		expect((await rowsOf('starter-heroes.posts-entry')).sections).toContainEqual({
			where: 'institute',
			rows: [expect.objectContaining({ id: 'scholar', actions: [{ page: 'heroes', label: { text: 'Assign heroes' } }] })],
		});
		// The defence order: ↑ / ↓ save the swapped order at once.
		const order = (await rowsOf('heroes.defense-rows')).sections[0].rows;
		expect(order[0].actions![0].blocked).toBeDefined();
		expect(order[0].actions![1]).toMatchObject({
			command: 'heroes.setDefenseOrder',
			payload: { settlement: c.id, heroes: [order[1].id, order[0].id] },
		});
		// Production before the assignment was banked at the old rate: the farm gave 1 food/s until then.
		const food = (await p.pool(at + 20_000)).amounts.food;
		const expected = (await p.pool(at + 10_000)).amounts.food + 10 * (pool.factor - pool.upkeep.food);
		expect(food).toBeCloseTo(expected, 3);
	});

	it('grow with experience: talent points by their own leanings, free points the player spends', async () => {
		const p = player({ 'starter-heroes.limits': { governors: 1 } });
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		await p.construct(T0, c.id, outer(c).id, 0, 'farm');
		const at = T0 + 100_000;
		await p.grant(at, 'gold', 1000);
		await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		const [h] = await heroes(p, at);
		expect(h).toMatchObject({ level: 1, exp: 0, expToNext: 100, freePoints: 0, alloc: {}, bonus: {} });
		// What it would give in each role.
		const roles = ((await p.views(at, ['starter-heroes.roles']))['starter-heroes.roles'] as HeroRoles)[h.id];
		expect(roles.governor).toContainEqual({ effect: 'production', percent: h.attrs.governance * 0.2 });
		// Battle %: 0.125% a point x level^0.21 (level 1 here).
		expect(roles.command).toContainEqual({ effect: 'attack', percent: h.attrs.might * 0.125 });
		// Talent: a total from the tavern's table (2-7), split over the attributes at recruitment.
		const sum = (a: Record<string, number>) => Object.values(a).reduce((x, y) => x + y, 0);
		expect(h.talent).toBeGreaterThanOrEqual(2);
		expect(h.talent).toBeLessThanOrEqual(7);
		expect(sum(h.talents!)).toBe(h.talent);

		await expect(p.run(at, 'heroes.grantExp', { hero: h.id, exp: 100 })).rejects.toThrow(); // GM only
		// 100 to level 2, round(100 x 2^1.5) = 283 to level 3: 400 makes level 3 with 17 to spare.
		await p.run(at, 'heroes.grantExp', { hero: h.id, exp: 400 }, true);
		const [g] = await heroes(p, at);
		expect(g).toMatchObject({ level: 3, exp: 17, expToNext: Math.round(100 * 3 ** 1.5), freePoints: 12 });
		// Every level up adds each attribute's own talent points.
		for (const [a, n] of Object.entries(h.attrs)) expect(g.attrs[a]).toBe(n + 2 * (h.talents![a] ?? 0));

		// The governor's production changes with its governance: the old rate is banked first.
		await p.run(at, 'heroes.assign', { hero: h.id, duty: 'governor', target: c.id });
		await expect(p.run(at, 'heroes.allocate', { hero: h.id, points: { governance: 13 } })).rejects.toThrow(/Only 12/);
		await expect(p.run(at, 'heroes.allocate', { hero: h.id, points: { luck: 1 } })).rejects.toThrow(/Unknown attribute/);
		await expect(p.run(at, 'heroes.allocate', { hero: h.id, points: { governance: -1 } })).rejects.toThrow(/whole numbers/);
		const before = await p.pool(at + 10_000);
		// As its form sends it: one number per attribute (empty ones 0), and the hidden free-points field.
		await p.run(at + 10_000, 'heroes.allocate', { hero: h.id, free: 12, 'points.governance': 10, 'points.might': 2, 'points.strategy': 0 });
		const [a] = await heroes(p, at + 10_000);
		expect(a).toMatchObject({ freePoints: 0, alloc: { governance: 10, might: 2 } });
		expect(a.attrs.governance).toBe(g.attrs.governance + 10);
		const after = await p.pool(at + 10_000);
		expect(after.factor).toBeCloseTo(before.factor + 10 * 0.002);
		expect(after.amounts.food).toBeCloseTo(before.amounts.food, 3); // banked at the old rate
		expect((await p.pool(at + 20_000)).amounts.food).toBeCloseTo(after.amounts.food + 10 * after.rates.food, 3);
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
		// Enough to never be routed (a routed army's heroes come back injured, tested in "bandits").
		await a.run(at, 'troops.grant', { settlement: ca.id, unit: 'cavalry-1', count: 500 }, true);
		await b.run(at, 'troops.grant', { settlement: cb.id, unit: 'infantry-1', count: 10 }, true);
		await expect(b.run(at, 'heroes.setDefenseOrder', { settlement: cb.id, heroes: [ha.id] })).rejects.toThrow(
			/attached to this settlement/,
		);

		await a.run(at, 'armies.send', { from: ca.id, x: cb.x, y: cb.y, units: { 'cavalry-1': 500 }, heroes: [ha.id] });
		expect((await heroes(a, at))[0].duty).toBe('command');
		const army = ((await a.views(at, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const { battle } = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(battle!.modifiers.attacker).toContainEqual({
			source: 'Commanding heroes',
			stat: 'attack',
			percent: ha.attrs.might * 0.125,
			flat: undefined,
		});
		expect(battle!.modifiers.defender).toContainEqual({
			source: 'Defending heroes',
			stat: 'defense',
			percent: hb.attrs.leadership * 0.125,
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

describe('realms', () => {
	const STRONG = { attack: { base: 1e6 }, defense: { base: 1e6 }, hp: { base: 1e6 } };
	const WEAK = {
		attack: { base: 1, might: 0, strategy: 0 },
		defense: { base: 0, might: 0, leadership: 0 },
		hp: { base: 1, might: 0, leadership: 0 },
	};
	const overview = async (p: ReturnType<typeof player>, now: number) =>
		(await p.views(now, ['realms.overview']))['realms.overview'] as RealmsOverview;
	const heroList = async (p: ReturnType<typeof player>, now: number) => (await p.views(now, ['heroes.list']))['heroes.list'] as HeroInfo[];
	/** A capital with a tavern and one recruited hero. */
	async function withHero(extra: Record<string, unknown> = {}) {
		const p = player({ 'buildings.speed': 1e6, ...extra });
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		await p.grant(T0 + 1_000, 'gold', 5000);
		await p.run(T0 + 1_000, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		const [hero] = await heroList(p, T0 + 1_000);
		return { p, c, hero, at: T0 + 1_000 };
	}

	it('trade blows in closed form: the hero strikes first, recovers between groups, and stops when it falls', () => {
		// The design example: a general (attack 190, defence 104, hp 710) against realm 1, task 1.
		const [first] = fightGroups({ attack: 190, defense: 104, hp: 710, recovery: 10 }, [
			{ name: 'Bandit', attack: 110, defense: 50, hp: 160 },
		]);
		expect(first).toEqual({ hpBefore: 710, hpAfter: 699, won: true, rounds: 2 });
		const out = fightGroups({ attack: 100, defense: 0, hp: 100, recovery: 50 }, [
			{ name: 'a', attack: 30, defense: 0, hp: 200 }, // 2 rounds, 1 blow taken: 70 left, +50 -> 100
			{ name: 'b', attack: 60, defense: 0, hp: 300 }, // 3 rounds, would take 2 blows (120): falls after 2
			{ name: 'c', attack: 1, defense: 0, hp: 1 },
		]);
		expect(out).toEqual([
			{ hpBefore: 100, hpAfter: 70, won: true, rounds: 2 },
			{ hpBefore: 100, hpAfter: 0, won: false, rounds: 2 },
		]);
	});

	it('are ten, five tasks each, harder and harder; only the first is open', async () => {
		const { p, hero, at } = await withHero();
		const o = await overview(p, at);
		expect(o.realms.map((r) => r.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(o.realms.map((r) => r.unlocked)).toEqual([true, false, false, false, false, false, false, false, false, false]);
		const [first, second] = o.realms;
		expect(first.tasks.map((t) => t.groups.length)).toEqual([5, 6, 6, 7, 8]);
		expect(first.tasks[0].groups[0]).toEqual({ name: 'Bandit', attack: 110, defense: 50, hp: 160 });
		expect(first.tasks[4].groups.at(-1)).toMatchObject({ name: 'Black Wind Chief', boss: true });
		// Five difficulty steps per realm, x1.06 each.
		expect(second.tasks[0].groups[0].attack).toBe(Math.round(110 * 1.06 ** 5));
		expect(first.tasks[0].exp[0]).toBe(20);
		// The Realms page as generic rows: the idle hero picked, each task with its expected outcome and a button.
		const list = (await p.views(at, ['realms.list']))['realms.list'] as RowsData;
		expect(list.picker).toMatchObject({ param: 'hero', selected: hero.id });
		const task = list.sections[1].rows[0];
		expect(task.actions).toEqual([
			expect.objectContaining({ command: 'realms.adventure', payload: { hero: hero.id, realm: first.id, task: 0 } }),
		]);
		expect(task.lines?.at(-1)?.text.text).toMatch(/^Expected: /);
		expect(list.sections[2].rows).toEqual([]); // locked
		// A button per realm, the newest open one shown by default.
		expect(list.tabs).toHaveLength(10);
		expect(list.defaultTab).toBe(first.id);
		expect(list.sections[1].group).toBe(first.id);
		// The hero's card (generic cards): its lines, plus its adventure numbers from realms; "Manage" opens its forms.
		const cards = (await p.views(at, ['heroes.cards']))['heroes.cards'] as CardsData;
		const card = cards.cards.find((x) => x.id === hero.id)!;
		expect(card.detail).toEqual({ label: { text: 'Manage' }, form: { placement: 'hero', context: { hero: hero.id } } });
		expect(card.lines?.some((l) => l.text.text.startsWith('Adventure: '))).toBe(true);
		const forms = (await p.views(at, ['ui.forms'], { placement: 'hero', hero: hero.id }))['ui.forms'] as { command: string }[];
		expect(forms.map((f) => f.command).sort()).toEqual(['heroes.assign', 'heroes.dismiss', 'heroes.setHome']);
		// The hero's numbers from its attributes (hero-stats.csv).
		expect(o.heroStats[hero.id]).toEqual({
			attack: 10 + 2 * hero.attrs.might + 0.5 * hero.attrs.strategy,
			defense: 5 + 0.3 * hero.attrs.might + hero.attrs.leadership,
			hp: 100 + 2 * hero.attrs.might + 6 * hero.attrs.leadership,
			recovery: 5 + 0.05 * hero.attrs.learning + 0.05 * hero.attrs.charm,
			luck: 0.3 * hero.attrs.charm,
		});
		// Herbalism adds recovery.
		await p.run(at, 'research.setLevel', { tech: 'herbalism', level: 2 }, true);
		expect((await overview(p, at)).heroStats[hero.id].recovery).toBeCloseTo(o.heroStats[hero.id].recovery + 4);
		await expect(p.run(at, 'realms.adventure', { hero: hero.id, realm: 'soul-valley', task: 0 })).rejects.toThrow(/locked/);
		await expect(p.run(at, 'realms.adventure', { hero: hero.id, realm: 'black-wind', task: 5 })).rejects.toThrow(/No such task/);
	});

	it('pay out when the adventure ends: experience, the key from the hardest task, one report; the key opens the next realm', async () => {
		const { p, c, hero, at } = await withHero({ 'starter-realms.heroStats': STRONG });
		await p.run(at, 'realms.adventure', { hero: hero.id, realm: 'black-wind', task: 4 });
		const [busy] = await heroList(p, at);
		expect(busy.duty).toBe('realms.adventure');
		// Away: no other duty, no moving, no second adventure.
		await expect(p.run(at, 'heroes.assign', { hero: hero.id, duty: 'governor', target: c.id })).rejects.toThrow(/busy/);
		await expect(p.run(at, 'heroes.setHome', { hero: hero.id, settlement: c.id })).rejects.toThrow(/busy/);
		await expect(p.run(at, 'realms.adventure', { hero: hero.id, realm: 'black-wind', task: 0 })).rejects.toThrow(/idle/);
		const o = await overview(p, at);
		expect(o.adventures).toEqual([expect.objectContaining({ hero: hero.id, realm: 'black-wind', task: 4, finishesAt: at + 8 * 120_000 })]);
		// The Realms page's timers: the hero away (name as name-part keys), back at the end.
		const away = (await p.views(at, ['realms.away']))['realms.away'] as TimersData;
		expect(away.items).toEqual([
			expect.objectContaining({ title: { text: '{hero}', vars: { hero: `${hero.surname} ${hero.given}` } }, endsAt: at + 8 * 120_000 }),
		]);

		const end = at + 8 * 120_000;
		expect((await inbox(p, end - 1)).messages.filter((m) => m.kind === 'realms.report')).toHaveLength(0);
		await p.run(end, 'realms.sync');
		await p.run(end + 1, 'realms.sync'); // nothing twice
		const reports = (await inbox(p, end)).messages.filter((m) => m.kind === 'realms.report');
		expect(reports).toHaveLength(1);
		const r = reports[0].data as RealmMail;
		const perGroup = Math.round(20 * 1.11 ** 4 * 1.3);
		expect(r).toMatchObject({ realm: 'black-wind', task: 4, cleared: true, injured: false, exp: 8 * perGroup });
		expect(r.groups).toHaveLength(8);
		expect(r.clearRewards).toEqual([expect.objectContaining({ kind: 'item', name: 'Key to Soul-Severing Valley', count: 1 })]);
		// Cleared once: its possible drops show, by how often they fall; the others stay hidden.
		const tasks = (await overview(p, end)).realms[0].tasks;
		expect(tasks[0]).toMatchObject({ cleared: false });
		expect(tasks[0].drops).toBeUndefined();
		const drops = tasks[4].drops!;
		expect(tasks[4].cleared).toBe(true);
		expect(drops.common.map((d) => d.name)).toContain('Scrap metal');
		// Equipment shows merged by set and colour: gold Azure Edge is rare in realm 1 (and there is no purple yet).
		expect(drops.rare).toContainEqual(expect.objectContaining({ kind: 'equipment', name: 'Azure Edge set', rarity: 'gold' }));
		expect([...drops.common, ...drops.uncommon, ...drops.rare].some((d) => d.rarity === 'purple')).toBe(false);
		expect(drops.clear).toEqual([expect.objectContaining({ name: 'Key to Soul-Severing Valley' })]);
		expect(drops.common.some((d) => d.name === 'Expansion permit')).toBe(false); // realm 1 has none
		// Levy orders are staggered by task: realm 1's last task drops only cavalry ones.
		const levies = [...drops.common, ...drops.uncommon, ...drops.rare].filter((d) => d.name.endsWith('Levy Order')).map((d) => d.name);
		expect(levies.length).toBeGreaterThan(0);
		expect(levies.every((n) => n.includes('(Cavalry)'))).toBe(true);
		const [back] = await heroList(p, end);
		expect(back.duty).toBe('idle');
		expect(back.level).toBeGreaterThan(1);
		expect((await overview(p, end)).adventures).toEqual([]);

		// The key: open the next realm (once), or trade it for resources.
		const keys = async () =>
			((await p.views(end, ['items.inventory']))['items.inventory'] as ItemStack[]).find((i) => i.id === 'realm-key-soul-valley')?.count ??
			0;
		expect(await keys()).toBe(1);
		await p.run(end, 'items.use.realm-key-soul-valley', { action: 'unlock' });
		expect((await overview(p, end)).realms[1].unlocked).toBe(true);
		await p.run(end, 'items.grant', { item: 'realm-key-soul-valley', count: 1 }, true);
		await expect(p.run(end, 'items.use.realm-key-soul-valley', { action: 'unlock' })).rejects.toThrow(/open already/);
		expect(await keys()).toBe(1); // a failed use costs nothing
		const before = (await p.pool(end)).amounts.metal;
		await p.run(end, 'items.use.realm-key-soul-valley', { action: 'exchange', settlement: c.id });
		expect((await p.pool(end)).amounts.metal).toBeCloseTo(before + 600);
		await p.run(end, 'realms.adventure', { hero: hero.id, realm: 'soul-valley', task: 0 });
	});

	it("drop none, one or several things per group, by the task's weights", async () => {
		const { p, hero, at } = await withHero({ 'starter-realms.heroStats': STRONG });
		const counts: number[] = [];
		let t = at;
		for (let i = 0; i < 6; i++) {
			await p.run(t, 'realms.adventure', { hero: hero.id, realm: 'black-wind', task: 4 });
			t += 8 * 120_000;
			await p.run(t, 'realms.sync');
		}
		for (const m of (await inbox(p, t)).messages.filter((x) => x.kind === 'realms.report'))
			for (const g of (m.data as RealmMail).groups) counts.push(g.rewards.length);
		expect(counts).toHaveLength(48);
		expect(counts).toContain(0);
		expect(counts).toContain(1);
		expect(counts.some((n) => n >= 2)).toBe(true);
	});

	it('luck (from charm) makes more drops likelier', async () => {
		const { p, hero, at } = await withHero({ 'starter-realms.heroStats': { ...STRONG, luck: { base: 1e6 } } });
		await p.run(at, 'realms.adventure', { hero: hero.id, realm: 'black-wind', task: 0 });
		await p.run(at + 5 * 120_000, 'realms.sync');
		const r = (await inbox(p, at + 5 * 120_000)).messages.find((m) => m.kind === 'realms.report')!.data as RealmMail;
		expect(r.groups.map((g) => g.rewards.length)).toEqual([3, 3, 3, 3, 3]); // the most drops nearly always
	});

	it('can be sped up by other plugins or the GM: the adventure (or treatment) ends sooner, report and all', async () => {
		const { p, hero, at } = await withHero({ 'starter-realms.heroStats': STRONG });
		await p.run(at, 'realms.adventure', { hero: hero.id, realm: 'black-wind', task: 4 }); // 8 groups, 16 min
		await expect(p.run(at, 'realms.hasten', { hero: hero.id, minutes: 5 })).rejects.toThrow(); // GM only
		await p.run(at, 'realms.hasten', { hero: hero.id, minutes: 5 }, true);
		expect((await overview(p, at)).adventures[0].finishesAt).toBe(at + 16 * 60_000 - 5 * 60_000);
		await p.run(at, 'realms.hasten', { hero: hero.id, seconds: 0 }, true); // end now: in this commit
		expect((await inbox(p, at)).messages.filter((m) => m.kind === 'realms.report')).toHaveLength(1);
		expect((await heroList(p, at))[0].duty).toBe('idle');
		await expect(p.run(at, 'realms.hasten', { hero: hero.id, seconds: 0 }, true)).rejects.toThrow(/neither/);
	});

	it('injure a hero that falls: earlier rewards kept, no duties or moving until treated with time and resources', async () => {
		const { p, c, hero, at } = await withHero({ 'starter-realms.heroStats': WEAK });
		await p.run(at, 'realms.adventure', { hero: hero.id, realm: 'black-wind', task: 0 });
		const end = at + 120_000; // fell in the first group
		await p.run(end, 'realms.sync');
		const r = (await inbox(p, end)).messages.find((m) => m.kind === 'realms.report')!.data as RealmMail;
		expect(r).toMatchObject({ cleared: false, injured: true, exp: 0 });
		expect(r.groups).toEqual([expect.objectContaining({ won: false, hpAfter: 0 })]);
		const [hurt] = await heroList(p, end);
		expect(hurt.duty).toBe('realms.injured');
		await expect(p.run(end, 'heroes.assign', { hero: hero.id, duty: 'governor', target: c.id })).rejects.toThrow(/busy/);
		await expect(p.run(end, 'heroes.setHome', { hero: hero.id, settlement: c.id })).rejects.toThrow(/busy/);
		await expect(p.run(end, 'heroes.dismiss', { hero: hero.id })).rejects.toThrow(/idle/);
		await expect(p.run(end, 'realms.adventure', { hero: hero.id, realm: 'black-wind', task: 0 })).rejects.toThrow(/idle/);

		const [injury] = (await overview(p, end)).injured;
		expect(injury).toEqual({ hero: hero.id, healingUntil: null, cost: { food: 100, gold: 50 }, seconds: 660 });
		await p.grant(end, 'food', -100_000);
		await expect(p.run(end, 'realms.heal', { hero: hero.id })).rejects.toThrow(/insufficient|Not enough/i);
		await p.grant(end, 'food', 1000);
		const gold = (await p.pool(end)).amounts.gold;
		await p.run(end, 'realms.heal', { hero: hero.id });
		expect((await p.pool(end)).amounts.gold).toBeCloseTo(gold - 50);
		await expect(p.run(end, 'realms.heal', { hero: hero.id })).rejects.toThrow(/Already/);
		expect((await overview(p, end)).injured[0].healingUntil).toBe(end + 660_000);
		await p.run(end + 660_000, 'realms.sync');
		expect((await heroList(p, end + 660_000))[0].duty).toBe('idle');
		expect((await overview(p, end + 660_000)).injured).toEqual([]);
	});

	it('hold tiles on the map: the GM (or the background task) places them, the map marks them, the tile offers an adventure', async () => {
		const { p, hero, at } = await withHero({ 'realms.rules': { sitesPerRealm: 1 } });
		await expect(p.run(at, 'realms.spawnSites', { count: 3 })).rejects.toThrow();
		await p.run(at, 'realms.spawnSites', { count: 100 }, true);
		const o = await overview(p, at);
		for (const r of o.realms) expect(r.sites.length).toBeGreaterThanOrEqual(1);
		const site = o.realms[0].sites[0];
		const markers = (await p.views(at, ['world-map.markers'], { x: String(site.x), y: String(site.y), r: '1' }))[
			'world-map.markers'
		] as MapMarker[];
		expect(markers).toContainEqual(expect.objectContaining({ x: site.x, y: site.y, kind: 'realms.site', name: 'Black Wind Ridge' }));
		const forms = (await p.views(at, ['ui.forms'], { placement: 'tile', x: String(site.x), y: String(site.y) }))[
			'ui.forms'
		] as ResolvedForm[];
		const form = forms.find((f) => f.command === 'realms.adventure')!;
		expect(form.fields.find((f) => f.name === 'realm')!.default).toBe('black-wind');
		expect(form.fields.find((f) => f.name === 'hero')!.options!.map((x) => x.value)).toEqual([hero.id]);
		// Nobody can found a settlement on it.
		expect(forms.some((f) => f.command === 'settling.found')).toBe(false);
	});
});

describe('equipment', () => {
	/** A test realm that always drops (one weak group), and a command making a piece with given stats. */
	const testGear = definePlugin({
		id: 'test-gear',
		version: '0',
		dependsOn: ['realms', 'equipment'],
		setup(ctx) {
			ctx.services.get('realms').define({
				id: 'test-cave',
				name: 'Test Cave',
				order: 3,
				locked: false,
				tasks: () => [{ name: 'Poke', groups: [{ name: 'Rat', attack: 1, defense: 0, hp: 1 }], exp: [1], dropCounts: [0, 1] }],
			});
			const equipment = ctx.services.get('equipment');
			ctx.commands.add<{ base: string; rarity: string; stats: Record<string, number>; settlement?: string }>({
				type: 'test-gear.make',
				parse: (raw) => raw as { base: string; rarity: string; stats: Record<string, number>; settlement?: string },
				async execute(api, { settlement, ...piece }) {
					const at = settlement ?? (await ctx.services.get('settlements').capital(api, api.playerId))!.id;
					if (!(await equipment.create(api, api.playerId, at, piece))) throw new GameError('full', 'Storage full');
				},
			});
		},
	});
	const kernel = createKernel([...plugins, testGear]);
	const bag = async (p: ReturnType<typeof player>, now: number) => (await p.views(now, ['equipment.bag']))['equipment.bag'] as EquipmentBag;
	const heroList = async (p: ReturnType<typeof player>, now: number) => (await p.views(now, ['heroes.list']))['heroes.list'] as HeroInfo[];
	async function withHero(extra: Record<string, unknown> = {}) {
		const p = player({ 'buildings.speed': 1e6, ...extra }, kernel);
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		await p.grant(T0 + 1_000, 'gold', 5000);
		await p.run(T0 + 1_000, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		const [hero] = await heroList(p, T0 + 1_000);
		return { p, c, hero, at: T0 + 1_000 };
	}

	it('drops in realms by tier, with a rolled rarity; a full bag loses the piece', async () => {
		const items = [
			'land-grant',
			'breakthrough-stone',
			'expansion-permit',
			'city-charter',
			'manual-scrap',
			'war-manual',
			'golden-salve',
			'scrap-metal',
		];
		const vouchers = ['grain', 'timber', 'stone', 'iron', 'coin'].map((v) => `${v}-voucher`);
		const levies = ['infantry', 'archer', 'cavalry'].flatMap((f) => [2, 3, 4].map((t) => `levy-${f}-${t}`));
		const noItems = { 'realms.dropWeights': Object.fromEntries([...items, ...vouchers, ...levies].map((id) => [id, 0])) };
		// No accessories either: only the regular sets below.
		const { p, hero, at } = await withHero({ ...noItems, 'equipment.storage': 1, 'starter-equipment.rules': { drop: { accessory: 0 } } });
		await p.run(at, 'realms.adventure', { hero: hero.id, realm: 'test-cave', task: 0 });
		await p.run(at + 120_000, 'realms.sync');
		const [piece] = (await bag(p, at + 120_000)).pieces;
		// Realm order 3 drops pieces of the sets whose ranges include it (Azure Edge, Iron Guard, Wanderer).
		expect(piece.hero).toBeNull();
		expect(['Azure Edge set', 'Iron Guard set', 'Wanderer set']).toContain(piece.set);
		expect(['white', 'green', 'blue', 'gold', 'purple']).toContain(piece.rarity);
		const report = (await inbox(p, at + 120_000)).messages.find((m) => m.kind === 'realms.report')!.data as RealmMail;
		expect(report.groups[0].rewards).toEqual([expect.objectContaining({ kind: 'equipment', name: piece.name, rarity: piece.rarity })]);
		// Shown as a generic report: a row per group, the drop in its colour.
		const shown = (await inbox(p, at + 120_000)).messages.find((m) => m.kind === 'realms.report')!.report!;
		expect(shown.lanes?.rows).toHaveLength(report.groups.length);
		expect(shown.lanes?.rows[0].cells[3]).toEqual([expect.objectContaining({ rarity: piece.rarity })]);
		// Again with the bag full: the report says it was lost.
		await p.run(at + 120_000, 'realms.adventure', { hero: hero.id, realm: 'test-cave', task: 0 });
		await p.run(at + 240_000, 'realms.sync');
		const second = (await inbox(p, at + 240_000)).messages.filter((m) => m.kind === 'realms.report')[0].data as RealmMail;
		expect(second.groups[0].rewards[0]).toMatchObject({ kind: 'equipment', lost: true });
		expect((await bag(p, at + 240_000)).pieces).toHaveLength(1);
	});

	it('are stored in settlements: heroes there share them, others cannot reach them; an armory stores more', async () => {
		const { p, c, hero, at } = await withHero();
		const make = (stats: Record<string, number>, settlement?: string) =>
			p.run(at, 'test-gear.make', { base: 'azure-edge-weapon', rarity: 'white', stats, ...(settlement ? { settlement } : {}) });
		for (let i = 0; i < 3; i++) await make({ 'adv.attack': i + 1 });
		await expect(make({ 'adv.attack': 9 })).rejects.toThrow(/Storage full/); // 3 without an armory
		expect((await bag(p, at)).storage[c.id]).toEqual({ used: 3, capacity: 3 });
		const [a, b] = (await bag(p, at)).pieces;
		await p.run(at, 'equipment.equip', { piece: a.id, hero: hero.id });
		expect((await bag(p, at)).storage[c.id].used).toBe(2);
		await make({ 'adv.attack': 9 }); // room again
		// Swapping from storage puts the old piece in its place; taking it off needs room.
		await p.run(at, 'equipment.equip', { piece: b.id, hero: hero.id });
		expect((await bag(p, at)).pieces.find((x) => x.id === a.id)).toMatchObject({ hero: null, settlement: c.id });
		await expect(p.run(at, 'equipment.unequip', { piece: b.id })).rejects.toThrow(/No room/);
		// The same as generic rows: the chosen hero's slots (a picker of this settlement's heroes), then storage.
		const gear = (await p.views(at, ['equipment.gear']))['equipment.gear'] as RowsData;
		expect(gear.picker).toMatchObject({ param: 'hero', selected: hero.id });
		expect(gear.sections[0].rows.find((r) => r.id === 'weapon')).toMatchObject({
			rarity: 'white',
			actions: [{ command: 'equipment.unequip', payload: { piece: b.id } }],
		});
		const storage = gear.sections.at(-1)!;
		expect(storage.title).toEqual({ text: 'Stored here {0} / {1}', vars: { 0: 3, 1: 3 } });
		expect(storage.rows.find((r) => r.id === a.id)?.actions?.map((x) => x.command)).toEqual(['equipment.equip', 'equipment.smelt']);
		// An armory: 20 more a level...
		await p.construct(at, c.id, inner(c).id, 1, 'armory');
		expect((await bag(p, at + 1_000)).storage[c.id].capacity).toBe(23);
		await p.run(at + 1_000, 'equipment.unequip', { piece: b.id });
		// ...up to 14 (280), then doubling from 15 (560, 1120).
		const armoryAt = async (level: number) => {
			await p.run(at + 1_000, 'buildings.setLevel', { settlement: c.id, district: inner(c).id, slot: 1, level }, true);
			return (await bag(p, at + 1_000)).storage[c.id].capacity - 3;
		};
		expect([await armoryAt(14), await armoryAt(15), await armoryAt(16)]).toEqual([280, 560, 1120]);
		// A piece stored in another settlement is out of this hero's reach.
		const tile = { x: wrap(c.x + 8), y: c.y };
		await p.run(at + 1_000, 'settlements.found', { kind: 'city', ...tile, name: 'Far' }, true);
		const far = (await p.mine(at + 1_000)).find((x) => x.name === 'Far')!;
		await make({ 'adv.attack': 5 }, far.id);
		const away = (await bag(p, at + 1_000)).pieces.find((x) => x.settlement === far.id)!;
		await expect(p.run(at + 1_000, 'equipment.equip', { piece: away.id, hero: hero.id })).rejects.toThrow(/Only heroes of the settlement/);
	});

	it('come in chests of one set and colour: a random piece of it, refused (and kept) when storage is full', async () => {
		const p = player();
		const c = await p.start();
		const chest = 'chest-azure-edge-gold';
		expect(((await p.views(T0, ['items.cards']))['items.cards'] as CardsData).cards.some((x) => x.id === chest)).toBe(false);
		// For sale in the shop, under "chests", the name in its colour.
		const shopCards = (await p.views(T0, ['shop.cards']))['shop.cards'] as CardsData;
		expect(shopCards.groups?.map((g) => g.id)).toContain('chests');
		// No white chests: white pieces are sold in the realm shop.
		expect(shopCards.cards.filter((x) => x.group === 'chests')).toHaveLength(44);
		expect(shopCards.cards.some((x) => x.id.endsWith('-white'))).toBe(false);
		// Accessory sets go by their short name: "绿色素心饰品宝箱".
		expect(shopCards.cards.find((x) => x.id === 'chest-plain-heart-green')?.title).toEqual({
			text: 'rarity:green chest-set:plain-heart accessory chest',
		});
		expect(shopCards.cards.find((x) => x.id === chest)).toMatchObject({
			group: 'chests',
			rarity: 'gold',
			lines: [{ text: { vars: { n: '300' } } }, expect.anything()],
		});
		await p.run(T0, 'items.grant', { item: chest, count: 4 }, true);
		const card = ((await p.views(T0, ['items.cards']))['items.cards'] as CardsData).cards.find((x) => x.id === chest)!;
		expect(card).toMatchObject({ title: { text: 'rarity:gold Azure Edge set chest' }, rarity: 'gold', count: 4 });
		for (let i = 0; i < 3; i++) await p.run(T0 + i, `items.use.${chest}`, { settlement: c.id });
		const pieces = (await bag(p, T0 + 3)).pieces;
		expect(pieces).toHaveLength(3);
		for (const x of pieces) expect(x).toMatchObject({ rarity: 'gold', set: 'Azure Edge set', settlement: c.id });
		// Storage holds 3 without an armory: the fourth is refused and the chest kept.
		await expect(p.run(T0 + 3, `items.use.${chest}`, { settlement: c.id })).rejects.toThrow(/No room/);
		expect((await bag(p, T0 + 3)).pieces).toHaveLength(3);
		expect(((await p.views(T0 + 3, ['items.cards']))['items.cards'] as CardsData).cards.find((x) => x.id === chest)?.count).toBe(1);
	});

	it('accessories drop in colour (never white) and always give some charm', async () => {
		const items = [
			'land-grant',
			'breakthrough-stone',
			'expansion-permit',
			'manual-scrap',
			'war-manual',
			'golden-salve',
			'scrap-metal',
			'recruit-edict',
		];
		const vouchers = ['grain', 'timber', 'stone', 'iron', 'coin'].map((v) => `${v}-voucher`);
		const sets = ['azure-edge', 'iron-guard', 'wanderer', 'mountain-warden', 'dragon-stride', 'phoenix-plume', 'heavens-plan'];
		const colours = ['white', 'green', 'blue', 'gold', 'purple'];
		const levies = ['infantry', 'archer', 'cavalry'].flatMap((f) => [2, 3, 4].map((t) => `levy-${f}-${t}`));
		const off = [...items, ...vouchers, ...levies, ...sets.flatMap((x) => colours.map((c) => `starter-equipment.${x}.${c}`))];
		const { p, hero, at } = await withHero({ 'realms.dropWeights': Object.fromEntries(off.map((id) => [id, 0])), 'equipment.storage': 50 });
		let t = at;
		for (let i = 0; i < 5; i++) {
			await p.run(t, 'realms.adventure', { hero: hero.id, realm: 'test-cave', task: 0 });
			t += 120_000;
			await p.run(t, 'realms.sync');
		}
		const pieces = (await bag(p, t)).pieces;
		expect(pieces).toHaveLength(5);
		for (const x of pieces) {
			expect(x.set).toBe('Plain Heart set'); // the accessory set of realm 3
			expect(x.rarity).not.toBe('white');
			expect(x.stats['attr.charm']).toBeGreaterThanOrEqual(1);
		}
	});

	it('sets: minimum levels, accessories only for women (as many as their talent allows), the realm shop sells white pieces', async () => {
		const { p, c, hero, at } = await withHero();
		for (const r of ['stone', 'wood', 'food', 'gold']) await p.grant(at, r, 100_000);
		// The realm shop: white pieces the opened realms drop (here realm 1 and this test's cave, order 3).
		const shop = async () => ((await p.views(at, ['starter-equipment.shop']))['starter-equipment.shop'] as RealmShop).offers;
		const offers = await shop();
		expect(offers.map((o) => o.set)).toContain('Azure Edge set');
		expect(offers.map((o) => o.set)).not.toContain('Mountain Warden set');
		expect(offers.find((o) => o.base === 'azure-edge-weapon')!.cost).toEqual({ gold: 200 });
		await expect(p.run(at, 'starter-equipment.buy', { base: 'mountain-warden-weapon', settlement: c.id })).rejects.toThrow(/Not for sale/);
		const shopData = (await p.views(at, ['starter-equipment.shop-rows']))['starter-equipment.shop-rows'] as RowsData;
		const shopRows = shopData.sections[0].rows;
		// Every realm has its section (following the realm picked on the right); one not open yet shows its pieces, not for sale.
		const locked = shopData.sections.find((x) => x.title?.text === '{0} 🔒')!;
		expect(locked.rows.length).toBeGreaterThan(0);
		expect(locked.rows[0].actions?.[0].blocked).toEqual({ text: 'Open this realm to buy its pieces.' });
		expect(shopRows.find((r) => r.id === 'azure-edge-armour')).toMatchObject({
			rarity: 'white',
			actions: [{ command: 'starter-equipment.buy', payload: { base: 'azure-edge-armour', settlement: c.id } }],
		});
		await p.run(at, 'starter-equipment.buy', { base: 'azure-edge-armour', settlement: c.id });
		const armour = (await bag(p, at)).pieces[0];
		expect(armour).toMatchObject({ rarity: 'white', minLevel: 3, set: 'Azure Edge set' });
		expect(Object.keys(armour.stats).some((k) => k.startsWith('attr.'))).toBe(false); // white: no attributes
		// Level 3 needed.
		await expect(p.run(at, 'equipment.equip', { piece: armour.id, hero: hero.id })).rejects.toThrow(/level 3/);
		await p.run(at, 'heroes.grantExp', { hero: hero.id, exp: 400 }, true);
		await p.run(at, 'equipment.equip', { piece: armour.id, hero: hero.id });

		// Accessories: a man wears none; a woman as many as her talent allows, one of each kind.
		await p.run(at, 'equipment.unequip', { piece: armour.id });
		await p.run(at, 'test-gear.make', { base: 'plain-heart-acc-ring', rarity: 'green', stats: { 'attr.charm': 1 } });
		await p.run(at, 'test-gear.make', { base: 'plain-heart-acc-earring', rarity: 'green', stats: { 'attr.charm': 1 } });
		const ring = (await bag(p, at)).pieces.find((x) => x.base === 'plain-heart-acc-ring')!;
		await expect(p.run(at, 'equipment.equip', { piece: ring.id, hero: hero.id })).rejects.toThrow(/cannot wear/);
		await p.run(at, 'heroes.gift', { settlement: c.id, venue: 'tavern' }, true); // a tavern hero is a man; make a woman instead:
		await p.construct(at, c.id, inner(c).id, 1, 'music-house');
		await p.run(at + 1_000, 'heroes.gift', { settlement: c.id, venue: 'music-house' }, true);
		const gift = ((await p.views(at + 1_000, ['heroes.candidates']))['heroes.candidates'] as HeroCandidates[])
			.find((v) => v.venue === 'music-house')!
			.candidates.find((x) => x?.gift)!;
		await p.run(at + 1_000, 'heroes.recruit', { settlement: c.id, venue: 'music-house', gift: gift.gift });
		const her = (await heroList(p, at + 1_000)).find((h) => h.gender === 'f')!;
		const limit = (await bag(p, at + 1_000)).groups[her.id].accessory;
		await expect(p.run(at + 1_000, 'equipment.equip', { piece: ring.id, hero: her.id })).rejects.toThrow(/level 5/);
		await p.run(at + 1_000, 'heroes.grantExp', { hero: her.id, exp: 2000 }, true);
		expect(limit).toBeGreaterThanOrEqual(1); // music-house talent 4-9: 1-10 accessories
		await p.run(at + 1_000, 'equipment.equip', { piece: ring.id, hero: her.id });
		expect((await bag(p, at + 1_000)).pieces.find((x) => x.id === ring.id)!.hero).toBe(her.id);
	});

	it('worn: adds attributes, adventure numbers and battle bonuses; only heroes at home change it; smelts to metal', async () => {
		const { p, c, hero, at } = await withHero({ 'armies.speed': 1e6, 'armies.minSeconds': 0 });
		const stats = async () => ((await p.views(at, ['realms.overview']))['realms.overview'] as RealmsOverview).heroStats[hero.id];
		const plain = await stats();
		await p.run(at, 'test-gear.make', {
			base: 'azure-edge-weapon',
			rarity: 'blue',
			stats: { 'adv.attack': 50, 'battle.attack': 10, 'attr.might': 12 },
		});
		await p.run(at, 'test-gear.make', { base: 'azure-edge-helm', rarity: 'white', stats: { 'adv.hp': 80 } });
		await p.run(at, 'test-gear.make', { base: 'azure-edge-weapon', rarity: 'white', stats: { 'adv.attack': 60 } });
		const [sword, helm, sabre] = (await bag(p, at)).pieces;
		await p.run(at, 'equipment.equip', { piece: sword.id, hero: hero.id });
		await p.run(at, 'equipment.equip', { piece: helm.id, hero: hero.id });
		const [worn] = await heroList(p, at);
		expect(worn.bonus).toEqual({ might: 12 });
		expect(worn.attrs.might).toBe(hero.attrs.might); // own attributes unchanged
		expect(await stats()).toMatchObject({ attack: plain.attack + 50 + 2 * 12, hp: plain.hp + 80 + 2 * 12 });
		// Same slot: the old piece goes back to the bag.
		await p.run(at, 'equipment.equip', { piece: sabre.id, hero: hero.id });
		const pieces = (await bag(p, at)).pieces;
		expect(pieces.find((x) => x.id === sword.id)!.hero).toBeNull();
		expect(pieces.find((x) => x.id === sabre.id)!.hero).toBe(hero.id);
		await p.run(at, 'equipment.equip', { piece: sword.id, hero: hero.id });

		// Leading an army: the battle bonus counts; away, nothing can be changed.
		await p.run(at, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 20 }, true);
		const camp = { x: wrap(c.x + 5), y: c.y };
		await p.run(at, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...camp }, true);
		await p.run(at, 'armies.send', { from: c.id, ...camp, units: { 'infantry-1': 20 }, heroes: [hero.id] });
		await expect(p.run(at, 'equipment.unequip', { piece: sword.id })).rejects.toThrow(/busy/);
		await expect(p.run(at, 'equipment.equip', { piece: sabre.id, hero: hero.id })).rejects.toThrow(/busy/);
		const report = ((await p.views(at + 1_500, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report!;
		expect(report.battle!.modifiers.attacker).toContainEqual({ source: 'Equipment', stat: 'attack', flat: 10 });
		// The leading hero adds flat numbers from its attributes too (might x 2.5 x level^0.75, equipment included).
		expect(report.battle!.modifiers.attacker).toContainEqual({
			source: 'Commanding heroes',
			stat: 'attack',
			flat: Math.round((hero.attrs.might + 12) * 2.5),
		});

		// Dismantling: only stored pieces; 60 x set scale x colour, half of it metal.
		await expect(p.run(at, 'equipment.smelt', { piece: sword.id })).rejects.toThrow(/Take it off/);
		const metal = (await p.pool(at)).amounts.metal;
		await p.run(at, 'equipment.smelt', { piece: sabre.id });
		expect((await p.pool(at)).amounts.metal).toBeCloseTo(metal + 30);
		expect((await bag(p, at)).pieces.map((x) => x.id)).not.toContain(sabre.id);
		await expect(p.run(at, 'equipment.smelt', { piece: sabre.id })).rejects.toThrow(/No such piece/);
	});
});

describe('shop and items', () => {
	const store = async (p: ReturnType<typeof player>, now: number) => (await p.views(now, ['shop.store']))['shop.store'] as ShopStore;
	const have = async (p: ReturnType<typeof player>, now: number, item: string) =>
		((await p.views(now, ['items.inventory']))['items.inventory'] as ItemStack[]).find((i) => i.id === item)?.count ?? 0;
	const heroList = async (p: ReturnType<typeof player>, now: number) => (await p.views(now, ['heroes.list']))['heroes.list'] as HeroInfo[];

	it('shows its offers as generic cards: price in red and buying blocked when short, the daily limit', async () => {
		const p = player({ 'shop.offers': { 'city-charter': { price: 50 } } });
		await p.start();
		await p.run(T0, 'shop.grant', { amount: 60 }, true);
		const cards = async () => (await p.views(T0, ['shop.cards']))['shop.cards'] as CardsData;
		let d = await cards();
		expect(d.summary).toEqual([{ text: '💰 {n} yuanbao', vars: { n: '60' } }]);
		expect(d.groups!.map((g) => g.id)).toContain('building');
		const card = (id: string) => d.cards.find((c) => c.id === id)!;
		expect(card('expansion-permit')).toMatchObject({
			group: 'building',
			lines: [{ tone: 'warn' }],
			actions: [{ blocked: { text: 'Not enough coupons' } }],
		});
		expect(card('city-charter').actions![0]).toEqual({ command: 'shop.buy', payload: { offer: 'city-charter' }, label: { text: 'Buy' } });
		await p.run(T0, 'shop.buy', { offer: 'city-charter' });
		d = await cards();
		expect(card('city-charter').lines![1]).toEqual({ text: { text: 'today {n} / {limit}', vars: { n: 1, limit: 1 } }, tone: 'muted' });
		expect(card('city-charter').actions![0].blocked).toEqual({ text: 'Daily limit reached' });
	});

	it('sells items for coupons the GM grants: prices, daily limits, GM changes, no double spending', async () => {
		const p = player({ 'shop.offers': { 'land-grant': { enabled: false }, 'manual-scrap': { price: 1 } } });
		await p.start();
		await expect(p.run(T0, 'shop.buy', { offer: 'grain-voucher' })).rejects.toThrow(/Not enough coupons/);
		await expect(p.run(T0, 'shop.grant', { amount: 100 })).rejects.toThrow(); // GM only
		await p.run(T0, 'shop.grant', { amount: 100 }, true);
		const s = await store(p, T0);
		expect(s.balance).toBe(100);
		// Coupons are whole numbers: a fraction is cut off, and the database refuses one outright.
		await p.run(T0, 'shop.grant', { amount: 0.7 }, true);
		expect((await store(p, T0)).balance).toBe(100);
		await expect(db.prepare('UPDATE shop_wallets SET balance = 100.5 WHERE player_id = ?').bind(p.id).run()).rejects.toThrow(/integer/);
		const row = await db.prepare('SELECT typeof(balance) AS t FROM shop_wallets WHERE player_id = ?').bind(p.id).first<{ t: string }>();
		expect(row!.t).toBe('integer');
		expect(s.offers.find((o) => o.id === 'grain-voucher')).toMatchObject({
			item: 'grain-voucher',
			count: 1,
			price: 20,
			category: 'resources',
		});
		expect(s.offers.some((o) => o.id === 'land-grant')).toBe(false); // the GM took it off
		expect(s.offers.find((o) => o.id === 'manual-scrap')!.price).toBe(1);
		await expect(p.run(T0, 'shop.buy', { offer: 'land-grant' })).rejects.toThrow(/No such offer/);

		await p.run(T0, 'shop.buy', { offer: 'grain-voucher', quantity: 2 });
		expect((await store(p, T0)).balance).toBe(60);
		expect(await have(p, T0, 'grain-voucher')).toBe(2);

		// Three harvest prayers a day.
		await p.run(T0, 'shop.grant', { amount: 300 }, true);
		await p.run(T0, 'shop.buy', { offer: 'harvest-rite', quantity: 2 });
		await expect(p.run(T0, 'shop.buy', { offer: 'harvest-rite', quantity: 2 })).rejects.toThrow(/Daily limit reached \(2 \/ 3\)/);
		await p.run(T0, 'shop.buy', { offer: 'harvest-rite' });
		expect((await store(p, T0)).offers.find((o) => o.id === 'harvest-rite')).toMatchObject({ dailyLimit: 3, boughtToday: 3 });
		const tomorrow = (Math.floor(T0 / 86_400_000) + 1) * 86_400_000;
		expect((await store(p, tomorrow)).offers.find((o) => o.id === 'harvest-rite')!.boughtToday).toBe(0);

		// Racing purchases never spend the same coupons twice.
		const q = player();
		await q.start();
		await q.run(T0, 'shop.grant', { amount: 20 }, true);
		const results = await Promise.allSettled([1, 2, 3].map(() => q.run(T0, 'shop.buy', { offer: 'grain-voucher' })));
		expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
		expect((await store(q, T0)).balance).toBe(0);
		expect(await have(q, T0, 'grain-voucher')).toBe(1);
	});

	it('vouchers and speed-ups work on the selected settlement; with nothing to speed up the item is kept', async () => {
		const p = player({ 'buildings.speed': 0.01 });
		const c = await p.start();
		const give = (item: string, count = 1) => p.run(T0, 'items.grant', { item, count }, true);
		await give('grain-voucher');
		const food = (await p.pool(T0)).amounts.food;
		await p.run(T0, 'items.use.grain-voucher', { settlement: c.id });
		expect((await p.pool(T0)).amounts.food).toBeCloseTo(food + 5000);

		await give('build-order-s', 2);
		await expect(p.run(T0, 'items.use.build-order-s', { settlement: c.id })).rejects.toThrow(/Nothing to speed up/);
		expect(await have(p, T0, 'build-order-s')).toBe(2);
		await p.construct(T0, c.id, inner(c).id, 0, 'institute'); // 60 s / 0.01
		const ends = async () => (await p.detail(T0)).districts.find((d) => d.type === 'inner')!.slots[0].construction?.finishesAt;
		const before = (await ends())!;
		await p.run(T0, 'items.use.build-order-s', { settlement: c.id });
		expect(await ends()).toBe(before - 900_000);
		expect(await have(p, T0, 'build-order-s')).toBe(1);
		// Long enough to finish: it is done at once.
		await give('build-order-l');
		await p.run(T0, 'items.use.build-order-l', { settlement: c.id });
		expect((await p.detail(T0)).districts.find((d) => d.type === 'inner')!.slots[0].current).toMatchObject({
			building: 'institute',
			level: 1,
		});

		// Research: done at once too.
		for (const r of ['wood', 'stone', 'gold']) await p.grant(T0, r, 5000);
		await p.run(T0, 'research.start', { tech: 'economics', settlement: c.id });
		await give('study-order-m');
		await p.run(T0, 'items.use.study-order-m', { settlement: c.id });
		const tree = (await p.views(T0, ['research.tree']))['research.tree'] as ResearchTree;
		expect(tree.techs.find((t) => t.id === 'economics')!.level).toBe(1);
		expect(tree.current).toBeNull();

		// Training: an hour off a long batch.
		const q = player({ 'buildings.speed': 1e6 });
		const d = await q.start();
		await q.construct(T0, d.id, inner(d).id, 0, 'barracks');
		await q.grant(T0 + 1_000, 'food', 100_000);
		await q.grant(T0 + 1_000, 'metal', 100_000);
		await q.grant(T0 + 1_000, 'gold', 100_000);
		await q.grant(T0 + 1_000, 'wood', 100_000);
		await q.grant(T0 + 1_000, 'stone', 100_000);
		await q.run(T0 + 1_000, 'troops.train', { settlement: d.id, unit: 'infantry-1', count: 500 });
		const g = async () => ((await q.views(T0 + 1_000, ['troops.garrison']))['troops.garrison'] as GarrisonInfo).training[0];
		const was = (await g()).finishesAt!;
		await q.run(T0 + 1_000, 'items.grant', { item: 'drill-order-m', count: 1 }, true);
		// It works on one barracks: not on one that trains nothing (the item is kept), then on the busy one.
		await expect(q.run(T0 + 1_000, 'items.use.drill-order-m', { settlement: d.id, barracks: 'archer-camp' })).rejects.toThrow(
			/Nothing is training in that barracks/,
		);
		await q.run(T0 + 1_000, 'items.use.drill-order-m', { settlement: d.id, barracks: 'barracks' });
		expect((await g()).finishesAt).toBe(Math.max(T0 + 1_000, was - 3_600_000));
	});

	it('a harvest prayer boosts production for a while (banked before and at the end); another one extends it', async () => {
		const p = player({ 'starter-items.boost': { hours: 0.01 } }); // 36 s
		const c = await p.start();
		await p.construct(T0, c.id, outer(c).id, 0, 'farm'); // 10 s, 1 food/s
		const t = T0 + 10_000;
		await p.grant(t, 'food', -(await p.pool(t)).amounts.food);
		await p.run(t, 'items.grant', { item: 'harvest-rite', count: 2 }, true);
		await p.run(t, 'items.use.harvest-rite', { settlement: c.id });
		expect((await p.pool(t)).factor).toBeCloseTo(1.25);
		await p.run(t + 10_000, 'items.use.harvest-rite', { settlement: c.id }); // until t + 72 s
		expect((await p.pool(t + 71_000)).factor).toBeCloseTo(1.25);
		expect((await p.pool(t + 100_000)).factor).toBeCloseTo(1);
		expect((await p.pool(t + 100_000)).amounts.food).toBeCloseTo(72 * 1.25 + 28, 1);
	});

	it('hero items: a salve heals the injured, manuals give experience, a marrow pill returns spent points', async () => {
		const p = player({
			'buildings.speed': 1e6,
			'starter-realms.heroStats': { attack: { base: 1, might: 0, strategy: 0 }, hp: { base: 1, might: 0, leadership: 0 } },
		});
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		const at = T0 + 1_000;
		await p.grant(at, 'gold', 5000);
		await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		const [hero] = await heroList(p, at);
		for (const item of ['golden-salve', 'manual-scrap', 'marrow-pill']) await p.run(at, 'items.grant', { item, count: 1 }, true);
		const forms = async (now: number) =>
			((await p.views(now, ['ui.forms'], { placement: 'items' }))['ui.forms'] as ResolvedForm[]).map((f) => f.command);
		expect(await forms(at)).not.toContain('items.use.golden-salve'); // nobody is injured
		expect(await forms(at)).not.toContain('items.use.marrow-pill'); // no points spent

		await p.run(at, 'realms.adventure', { hero: hero.id, realm: 'black-wind', task: 0 });
		await p.run(at + 120_000, 'realms.sync');
		expect((await heroList(p, at + 120_000))[0].duty).toBe('realms.injured');
		expect(await forms(at + 120_000)).toContain('items.use.golden-salve');
		await p.run(at + 120_000, 'items.use.golden-salve', { hero: hero.id });
		expect((await heroList(p, at + 120_000))[0].duty).toBe('idle');

		await p.run(at + 120_000, 'items.use.manual-scrap', { hero: hero.id });
		const grown = (await heroList(p, at + 120_000))[0];
		expect(grown.level).toBeGreaterThan(1);
		await p.run(at + 120_000, 'heroes.allocate', { hero: hero.id, points: { might: 3 } });
		await p.run(at + 120_000, 'items.use.marrow-pill', { hero: hero.id });
		const back = (await heroList(p, at + 120_000))[0];
		expect(back).toMatchObject({ freePoints: grown.freePoints, alloc: {} });
		expect(back.attrs.might).toBe(grown.attrs.might);
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

describe('prestige', () => {
	const status = async (p: ReturnType<typeof player>, now = T0) =>
		(await p.views(now, ['prestige.status']))['prestige.status'] as PrestigeStatus;
	const cityLimit = async (p: ReturnType<typeof player>, now = T0) => {
		const api = {
			...engineContext(defaultKernel, p.id, now),
			db,
			services: defaultKernel.services,
			memo: (_k: string, l: () => Promise<unknown>) => l(),
		};
		return defaultKernel.services.get('stats').get(api as never, 'settlements.limit.city', `player:${p.id}`);
	};

	it('grows with what is spent (1 per 1,000), and a cancelled construction takes its share back', async () => {
		const p = player({ 'buildings.cancelRefund': 1 });
		const c = await p.start();
		expect(await status(p)).toMatchObject({
			value: 0,
			rank: { index: 0, name: 'Commoner' },
			next: { name: 'Village Head', threshold: 50 },
		});
		await p.construct(T0, c.id, inner(c).id, 0, 'warehouse'); // 100 stone + 150 wood
		expect((await status(p)).value).toBeCloseTo(0.25);
		await p.run(T0 + 1_000, 'buildings.cancel', { settlement: c.id, district: inner(c).id, slot: 0 });
		expect((await status(p, T0 + 1_000)).value).toBeCloseTo(0);
		expect((await status(p, T0 + 1_000)).best).toBeCloseTo(0.25); // the best stays
	});

	it('ranks follow the best prestige and never fall; five of them raise the city limit', async () => {
		const p = player({ 'player-settlements.limits': { city: 0 } });
		await p.start();
		expect(await cityLimit(p)).toBe(0);
		await p.run(T0, 'prestige.grant', { amount: 2795 }, true);
		expect(await status(p)).toMatchObject({ rank: { index: 5, name: 'County Magistrate' }, next: { name: 'Commandery Assistant' } });
		expect(await cityLimit(p)).toBe(1);
		// Bandits take it down: the value falls, the rank and its city do not.
		await p.run(T0, 'prestige.grant', { amount: -2000 }, true);
		expect(await status(p)).toMatchObject({ value: 795, best: 2795, rank: { index: 5 } });
		expect(await cityLimit(p)).toBe(1);
		await p.run(T0, 'prestige.grant', { amount: 1e6 }, true);
		expect(await status(p)).toMatchObject({ rank: { index: 29, name: 'Chancellor of State' } });
		expect((await status(p)).next).toBeUndefined();
		expect(await cityLimit(p)).toBe(5);
		await expect(p.run(T0, 'prestige.grant', { amount: 5 })).rejects.toThrow(); // GM only
		// The badge next to the user name (generic widget ui.badge): rank, prestige, what the next rank needs.
		const badge = (await p.views(T0, ['prestige.badge']))['prestige.badge'];
		expect(badge).toEqual({
			label: { text: 'Chancellor of State' },
			value: { text: 'Prestige {n}', vars: { n: '1,000,795' } },
			title: { text: 'The highest rank' },
		});
	});
});

describe('bandits', () => {
	const H = 3_600_000;
	const incoming = async (p: ReturnType<typeof player>, now: number) =>
		(await p.views(now, ['armies.incoming']))['armies.incoming'] as IncomingArmy[];
	const prestigeOf = async (p: ReturnType<typeof player>, now: number) =>
		((await p.views(now, ['prestige.status']))['prestige.status'] as PrestigeStatus).value;
	const sync = (p: ReturnType<typeof player>, now: number) => p.run(now, 'timeline.sync', { entity: `bandits:${p.id}` }, true);

	it('start with the capital: none in the first hours nor without prestige, then they come, sooner as prestige rises', async () => {
		// No jitter, so the times are exact.
		const p = player({ 'bandits.rules': { interval: { jitter: 0 } } });
		const c = await p.start();
		// First check 4 hours after founding (prestige 0 stands still): no prestige, no band.
		await sync(p, T0 + 4 * H);
		expect(await incoming(p, T0 + 4 * H)).toEqual([]);
		// With prestige: the next check (4 hours on) sends one; it arrives 3 minutes later (no scouts).
		await p.run(T0 + 4 * H, 'prestige.grant', { amount: 60 }, true);
		await sync(p, T0 + 8 * H);
		const [band] = await incoming(p, T0 + 8 * H);
		expect(band).toMatchObject({ settlement: c.id, arrivesAt: T0 + 8 * H + 3 * 60_000 });
		expect(band.attackerName).toBeTruthy();
		// The prestige just granted counts as "recent": the following check comes sooner than 4 hours.
		const row = await db.prepare('SELECT next_at FROM bandits_players WHERE player_id = ?').bind(p.id).first<{ next_at: number }>();
		expect(row!.next_at - (T0 + 8 * H)).toBeLessThan(4 * H);
		expect(row!.next_at - (T0 + 8 * H)).toBeGreaterThanOrEqual(20 * 60_000);
	});

	it('win against an empty town: they plunder, and the player loses prestige for what was taken', async () => {
		const p = player();
		const c = await p.start();
		await p.run(T0, 'prestige.grant', { amount: 100 }, true);
		await p.run(T0, 'bandits.spawn', {}, true);
		const [band] = await incoming(p, T0);
		const before = (await p.pool(T0)).amounts;
		await p.run(band.arrivesAt, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		expect(await incoming(p, band.arrivesAt)).toEqual([]); // gone once it struck
		const after = (await p.pool(band.arrivesAt)).amounts;
		const taken = Object.keys(before).reduce((sum, r) => sum + Math.max(0, before[r] - after[r]), 0);
		expect(taken).toBeGreaterThan(0);
		expect(await prestigeOf(p, band.arrivesAt)).toBeCloseTo(100 - taken * 0.5 * 0.001, 3);
		const mail = (await inbox(p, band.arrivesAt)).messages.find((m) => m.kind === 'war-reports.defense')!;
		expect(mail).toMatchObject({ title: '{settlement} was raided by {name}' });
		const report = (mail.data as DefenseMail).report;
		expect(report.attacker).toMatchObject({ name: band.attackerName, level: expect.any(Number) });
		expect(report.prestige).toBeLessThan(0);
	});

	it('beaten by a garrison: the player gains prestige for their fallen and may find something', async () => {
		const p = player({ 'bandits.rules': { drops: { first: 1, second: 0 } } });
		const c = await p.start();
		await p.run(T0, 'prestige.grant', { amount: 60 }, true);
		for (const u of ['infantry-3', 'archer-3', 'cavalry-3'])
			await p.run(T0, 'troops.grant', { settlement: c.id, unit: u, count: 500 }, true);
		await p.run(T0, 'bandits.spawn', { settlement: c.id }, true);
		await expect(p.run(T0, 'bandits.spawn', { settlement: c.id }, true)).rejects.toThrow(/No settlement/); // one band at a time
		const [band] = await incoming(p, T0);
		await p.run(band.arrivesAt, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		const report = ((await inbox(p, band.arrivesAt)).messages.find((m) => m.kind === 'war-reports.defense')!.data as DefenseMail).report;
		expect(report.outcome).toBe('defeat'); // the attackers'
		expect(Object.values(report.losses.attacker).some((n) => n > 0)).toBe(true);
		expect(report.prestige).toBeGreaterThan(0);
		expect(await prestigeOf(p, band.arrivesAt)).toBeCloseTo(60 + report.prestige!, 3);
		// One drop (first chance 1, second 0): a resource cache or a levy order for one of their families.
		expect(report.rewards).toEqual([
			expect.objectContaining({ kind: expect.stringMatching(/^(resource|item)$/), count: expect.any(Number) }),
		]);
	});

	it('come in numbers by prestige, in tiers by level, never in round blocks', async () => {
		const band = async (amount: number, rules: Record<string, unknown> = {}) => {
			const p = player({ 'bandits.rules': rules });
			await p.start();
			await p.run(T0, 'prestige.grant', { amount }, true);
			await p.run(T0, 'bandits.spawn', {}, true);
			const row = await db
				.prepare('SELECT level, lanes FROM bandits_raids WHERE player_id = ?')
				.bind(p.id)
				.first<{ level: number; lanes: string }>();
			const lanes = JSON.parse(row!.lanes) as { family: string; units: Record<string, number> }[];
			const counts = lanes.flatMap((l) => Object.values(l.units));
			const tiers = lanes.flatMap((l) => Object.keys(l.units).map((u) => Number(u.split('-').at(-1))));
			return { level: row!.level, total: counts.reduce((a, b) => a + b, 0), counts, maxTier: Math.max(...tiers) };
		};
		// Prestige 10,000: about 60 + 2 x 10,000 bandits, give or take 20%.
		const big = await band(10_000, { level: { spread: 0 } });
		expect(big.total).toBeGreaterThan(20_060 * 0.79);
		expect(big.total).toBeLessThan(20_060 * 1.21);
		// The level (from the same prestige: rank 9 of office -> level 3) only says which tiers: level 3 brings tiers 1-2.
		expect(big).toMatchObject({ level: 3, maxTier: 2 });
		// Not in round blocks: lanes and tiers differ.
		expect(new Set(big.counts).size).toBeGreaterThan(3);
		// Without jitter, the size is exact: level 1-2 bands at prestige 100 bring 60 + 200 tier-1 units.
		const small = await band(100, { size: { jitter: 0, laneJitter: 0, mixJitter: 0 }, level: { spread: 0 } });
		expect(small.maxTier).toBe(1);
		expect(Math.abs(small.total - 260)).toBeLessThanOrEqual(5);
	});

	it('injure the heroes leading a routed army', async () => {
		const fast = { 'armies.speed': 1e6, 'armies.minSeconds': 0, 'pvp.protectionHours': 0, 'buildings.speed': 1e6 };
		const a = player(fast);
		const b = player(fast);
		const ca = await a.start();
		const cb = await b.start();
		await a.construct(T0, ca.id, inner(ca).id, 0, 'tavern');
		await a.grant(T0 + 1_000, 'gold', 5000);
		await a.run(T0 + 1_000, 'heroes.recruit', { settlement: ca.id, venue: 'tavern', slot: 0 });
		const [hero] = (await a.views(T0 + 1_000, ['heroes.list']))['heroes.list'] as HeroInfo[];
		await a.run(T0 + 1_000, 'troops.grant', { settlement: ca.id, unit: 'infantry-1', count: 5 }, true);
		for (const u of ['infantry-3', 'archer-3', 'cavalry-3'])
			await b.run(T0 + 1_000, 'troops.grant', { settlement: cb.id, unit: u, count: 2000 }, true);
		await a.run(T0 + 1_000, 'armies.send', { from: ca.id, x: cb.x, y: cb.y, units: { 'infantry-1': 5 }, hero1: hero.id });
		const army = ((await a.views(T0 + 1_000, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const report = ((await a.views(army.arrivesAt, ['armies.list']))['armies.list'] as ArmyInfo[])[0]?.report;
		expect(report?.battle?.grade.attacker).toBe('routed');
		expect(((await a.views(army.arrivesAt, ['heroes.list']))['heroes.list'] as HeroInfo[])[0].duty).toBe('realms.injured');
	});

	it('injure the heroes defending a routed town, as a lost adventure does', async () => {
		const p = player({ 'buildings.speed': 1e6 });
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		await p.grant(T0 + 1_000, 'gold', 5000);
		await p.run(T0 + 1_000, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		await p.run(T0 + 1_000, 'prestige.grant', { amount: 2000 }, true);
		await p.run(T0 + 1_000, 'bandits.spawn', {}, true);
		const [band] = await incoming(p, T0 + 1_000);
		await p.run(band.arrivesAt, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		const report = ((await inbox(p, band.arrivesAt)).messages.find((m) => m.kind === 'war-reports.defense')!.data as DefenseMail).report;
		expect(report.battle!.grade.defender).toBe('routed'); // no troops at all
		const [hero] = (await p.views(band.arrivesAt, ['heroes.list']))['heroes.list'] as HeroInfo[];
		expect(hero.duty).toBe('realms.injured');
		const injured = ((await p.views(band.arrivesAt, ['realms.overview']))['realms.overview'] as RealmsOverview).injured;
		expect(injured.map((i) => i.hero)).toEqual([hero.id]);
	});

	it('scouts see them coming sooner', async () => {
		const p = player();
		await p.start();
		await p.run(T0, 'research.setLevel', { tech: 'scouts', level: 2 }, true);
		await p.run(T0, 'bandits.spawn', {}, true);
		const [band] = await incoming(p, T0);
		expect(band.arrivesAt).toBe(T0 + 30 * 60_000);
		expect(band.intel).toMatchObject({ level: 2 });
	});
});

// The example plugin of docs/plugin-guide.md: kept working by this test.
describe('example plugin (watchtower)', () => {
	const kernel = createKernel([...plugins, watchtower]);

	it('is built like any building and adds its defence to every lane when the settlement is attacked', async () => {
		const p = player({ 'buildings.speed': 1e6, 'watchtower.rules': { defensePerLevel: 50 } }, kernel);
		const c = await p.start();
		for (const r of ['food', 'wood', 'stone', 'metal', 'gold']) await p.grant(T0, r, 100_000);
		await p.construct(T0, c.id, inner(c).id, 0, 'watchtower');
		await p.construct(T0 + 1_000, c.id, inner(c).id, 0); // to level 2
		await p.run(T0 + 2_000, 'prestige.grant', { amount: 60 }, true);
		await p.run(T0 + 2_000, 'bandits.spawn', {}, true);
		const [band] = (await p.views(T0 + 2_000, ['armies.incoming']))['armies.incoming'] as IncomingArmy[];
		await p.run(band.arrivesAt, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		const report = ((await inbox(p, band.arrivesAt)).messages.find((m) => m.kind === 'war-reports.defense')!.data as DefenseMail).report;
		expect(report.battle!.modifiers.defender).toContainEqual(expect.objectContaining({ source: 'Watchtower', stat: 'defense', flat: 100 }));
	});
});

describe('generic grid (ui.grid)', () => {
	it('draws the world map from layers: terrain fills, settlements, home, legend, the tile forms', async () => {
		const p = player();
		const c = await p.start();
		const g = (await p.views(T0, ['world-map.grid'], { x: String(c.x), y: String(c.y), r: '2' }))['world-map.grid'] as GridData;
		// Beside it, the NPC settlements around the centre, as far as the side's choice says.
		expect(g.sides?.[0]).toMatchObject({ title: { text: 'NPC settlements nearby' }, choice: { param: 'nearbyR', selected: '20' } });
		const wider = (await p.views(T0, ['world-map.grid'], { x: String(c.x), y: String(c.y), r: '2', nearbyR: '10' }))[
			'world-map.grid'
		] as GridData;
		expect(wider.sides?.[0].choice?.selected).toBe('10');
		expect(g).toMatchObject({
			wrap: true,
			width: 1024,
			radius: 2,
			centre: { x: c.x, y: c.y },
			home: { x: c.x, y: c.y },
			placement: 'tile',
		});
		expect(g.cells).toHaveLength(25);
		const capital = g.cells.find((x) => x.x === c.x && x.y === c.y)!;
		expect(capital).toMatchObject({
			icon: '🏰',
			tone: 'mine',
			fill: expect.stringMatching(/^terrain-/),
			actions: [{ params: { settlement: c.id } }],
		});
		expect(g.legend!.length).toBeGreaterThan(3);
	});

	it('is reusable by a third party without client code: the otherworld example, a small grid of its own', async () => {
		const kernel = createKernel([...plugins, otherworld]);
		const layout = kernel.meta.get('ui')!() as UiLayout;
		expect(layout.pages).toContainEqual(
			expect.objectContaining({ id: 'otherworld', widget: 'ui.grid', props: { view: 'otherworld.grid', grid: 'otherworld' } }),
		);
		expect(layout.mail['otherworld.scouted']).toBe('ui.report');
		const p = player(undefined, kernel);
		await p.start();
		const g = (await p.views(T0, ['otherworld.grid']))['otherworld.grid'] as GridData;
		expect(g).toMatchObject({ width: 5, height: 5, wrap: false });
		const demon = g.cells.find((x) => x.icon === '👹')!;
		expect(demon).toMatchObject({ x: 4, y: 4, tone: 'enemy', actions: [{ command: 'otherworld.scout', payload: { x: 4, y: 4 } }] });
		// Its button sends a mail shown as a generic report; a tile with nobody is refused.
		await p.run(T0, 'otherworld.scout', { x: 4, y: 4 });
		const mail = (await inbox(p, T0)).messages[0];
		expect(mail).toMatchObject({ kind: 'otherworld.scouted', report: { tone: 'bad' } });
		await expect(p.run(T0, 'otherworld.scout', { x: 0, y: 0 })).rejects.toThrow(/Nobody lives there/);
	});

	it('takes extensions with a client widget of their own: the clock example', async () => {
		const kernel = createKernel([...plugins, clock]);
		const layout = kernel.meta.get('ui')!() as UiLayout;
		expect(layout.bands).toContainEqual(
			expect.objectContaining({ band: 'bottom', widget: 'clock.time', props: { view: 'clock.settings' } }),
		);
		expect((await player(undefined, kernel).views(T0, ['clock.settings']))['clock.settings']).toEqual({ utcOffset: 8 });
		expect((await player({ 'clock.utcOffset': -5 }, kernel).views(T0, ['clock.settings']))['clock.settings']).toEqual({ utcOffset: -5 });
	});
});
