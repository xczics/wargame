/** Settlements: the capital, construction, resource pools, outer cities and founding. */
import { describe, expect, it } from 'vitest';
import { computeViews, createKernel, definePlugin, engineContext, GameError, resolveConfig, stagedGrowth } from '../../src/kernel';
import { plugins } from '../../src/plugins';
import { wrap } from '../../src/plugins/world-map';
import type { MapTile, ResolvedForm } from '../../src/shared/api';
import { duration } from '../../src/shared/format';
import { expandChoices, resolveCell } from '../../src/shared/statics';
import type { CardsData, CellsData, TableData } from '../../src/shared/ui';
import { db, T0, defaultKernel, player, inner, outer } from '../helpers';

describe('capital', () => {
	it('is founded with an inner city, one outer city and the starting resources', async () => {
		const p = player();
		const capital = await p.start();
		expect(capital.kind).toBe('capital');
		expect(capital.districts.map((d) => d.type)).toEqual(['inner', 'outer']);
		// 22 slots, plus one holding the level-1 wall every settlement starts with.
		expect(inner(capital).slots).toHaveLength(23);
		expect(inner(capital).slots[22].current).toMatchObject({ building: 'wall', level: 1 });
		expect(outer(capital).slots.length).toBeGreaterThanOrEqual(6);
		expect(outer(capital).slots.length).toBeLessThanOrEqual(13);
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
		expect(warehouse?.effects).toEqual({ produces: {}, stats: { 'resources.capacity': 10_000 } });
	});

	it('shows production by resource: raw output, bonuses and upkeep by source, the net rate', async () => {
		const p = player({ 'buildings.speed': 1e6 });
		const c = await p.start();
		await p.construct(T0, c.id, outer(c).id, 0, 'farm');
		const at = T0 + 2_000;
		await p.run(at, 'research.setLevel', { tech: 'economics', level: 2 }, true);
		await p.run(at, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 100 }, true);
		const table = (await p.views(at, ['resources.production']))['resources.production'] as TableData;
		const pool = await p.pool(at);
		const food = table.rows.find((r) => r.id === 'food')!;
		const perHour = (n: number) => n * 3600;
		// Raw output, then Economics +8% of it, then the garrison's upkeep; the net is the pool's rate.
		const [, , net, raw, bonus, upkeep] = food.cells;
		expect(Number(raw.text.vars![0].toString().replace(/,/g, ''))).toBeCloseTo(perHour(pool.production.food), 0);
		expect(bonus.hint).toEqual([
			{
				text: 'resources.{0} {1}/h',
				vars: {
					0: { text: 'starter-research.{0} Lv {1}', vars: { 0: { text: 'starter-research.Treasury' }, 1: 2 } },
					1: expect.stringMatching(/^\+/),
				},
			},
		]);
		expect(upkeep.hint).toEqual([
			{ text: 'resources.{0} {1}/h', vars: { 0: { text: 'troops.Garrison' }, 1: expect.stringMatching(/^−/) } },
		]);
		const n = Number(String(net.text.vars![0]).replace(/[,+]/g, '').replace('−', '-'));
		expect(n).toBeCloseTo(perHour(pool.rates.food), 0);
		// The stock and "Full" go by the client's counters (counted on between syncs): the view is sent only when rates change.
		const stock = food.cells[1];
		expect(stock.counter).toBe('resource:food');
		expect(resolveCell(stock, () => -5)).toMatchObject({ text: { vars: { 0: '-5' } }, tone: 'warn' });
		if (net.over) {
			expect(resolveCell(net, () => net.over!.amount).text).toEqual({ text: 'resources.Full' });
			expect(resolveCell(net, () => 0).text).toEqual(net.text);
		}
		expect(table.columns).toHaveLength(6);
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
		expect(building.lines).toContainEqual({ text: { text: 'buildings.→ Lv {0}', vars: { 0: 1 } }, startedAt: T0, endsAt: T0 + 10_000 });
		expect(building.actions?.map((a) => a.command ?? a.entry?.kind)).toEqual(['buildings.cancel', 'building']);
		// An empty slot lists what can be built there, each a construct button: one static list per kind of district
		// (buildings.catalog), the card naming it and adding where to the buttons' payload.
		const empty = slots.cards.find((x) => x.id === `${c.id}/${inner(c).id}/0`)!;
		expect(empty).toMatchObject({ template: 'empty:capital|inner', payload: { slot: 0 } });
		expect(slots.choiceSets).toBeUndefined();
		expect(slots.base).toBe('buildings.catalog');
		const merged = (await p.shown(T0 + 5_000, ['buildings.slots']))['buildings.slots'] as CardsData;
		const choices = expandChoices(
			merged,
			merged.cards.find((x) => x.id === empty.id)!,
		);
		expect(choices.map((x) => x.action.payload?.building)).toContain('warehouse');
		expect(choices[0].action.payload).toEqual({ settlement: c.id, district: inner(c).id, slot: 0, building: expect.any(String) });
		// The time is the table's x this settlement's factor, worked out like the server's quote.
		const quoted = inner(await p.detail(T0 + 5_000)).slots[0].options.find((o) => o.building === 'warehouse')!;
		const time = choices.find((x) => x.id === 'warehouse')!.action.parts!.at(-1)!.text;
		expect(time?.vars?.[0]).toBe(`· ${duration(quoted.seconds)}`);
		// Short of a resource (the client's counters): that part in red and the button off; enough: on.
		const warehouse = (n: number) =>
			expandChoices(
				merged,
				merged.cards.find((x) => x.id === empty.id)!,
				() => n,
			).find((x) => x.id === 'warehouse')!;
		expect(warehouse(0).action.blocked).toEqual({ text: 'buildings.Not enough resources' });
		expect(warehouse(0).action.parts?.[0].tone).toBe('warn');
		expect(warehouse(1e9).action.blocked).toBeUndefined();
		// A standing building: its level's static upgrade card, the slot added to the button.
		const later = T0 + 86_400_000;
		const city = (await p.shown(later, ['buildings.slots']))['buildings.slots'] as CardsData;
		const own = (await p.views(later, ['buildings.slots']))['buildings.slots'] as CardsData;
		expect(own.cards.find((x) => x.id === building.id)?.template).toBe('farm@1');
		const farm = city.cards.find((x) => x.id === building.id)!;
		expect(farm.actions?.map((a) => a.command ?? a.entry?.kind)).toEqual(['buildings.construct', 'building']);
		expect(farm.actions?.[0].payload).toEqual({ settlement: c.id, district: outer(c).id, slot: 0, building: 'farm' });
		expect(slots.placement).toBe('settlement');
	});

	it('builds a slot card at any level from the static tables, as the server quotes it; tech and caps from counters', async () => {
		const p = player();
		const c = await p.start();
		await p.construct(T0, c.id, outer(c).id, 0, 'farm');
		const later = T0 + 86_400_000;
		const card = async (level: number) => {
			await p.run(later, 'buildings.setLevel', { settlement: c.id, district: outer(c).id, slot: 0, level }, true);
			const v = (await p.shown(later, ['buildings.slots']))['buildings.slots'] as CardsData;
			return v.cards.find((x) => x.id === `${c.id}/${outer(c).id}/0`)!;
		};
		// Level 6 of a farm needs Agriculture 1 (the research plugin's band, checked against the owner's level).
		expect((await card(5)).actions?.[0].blocked).toEqual({
			text: 'research.Requires {0} Lv {1}',
			vars: { 0: { text: 'starter-research.Agriculture' }, 1: 1 },
		});
		// Past the regular cap (no table row): the same price as the server's quote, and off at the cap.
		const past = await card(25);
		const quote = outer(await p.detail(later)).slots[0].options[0];
		const prices = past.actions?.[0].parts?.filter((x) => x.need).map((x) => [x.need!.counter.slice('resource:'.length), x.need!.amount]);
		expect(Object.fromEntries(prices ?? [])).toEqual(Object.fromEntries(Object.entries(quote.cost).filter(([, n]) => n > 0)));
		expect(past.actions?.[0].parts?.at(-1)?.text?.vars?.[0]).toBe(`· ${duration(quote.seconds)}`);
		expect(past.actions?.[0].blocked).toEqual({ text: 'buildings.Level cap {0} reached', vars: { 0: 20 } });
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
		await expect(p.construct(T0, c.id, inner(c).id, 0, 'town-hall')).rejects.toMatchObject({
			text: { text: 'buildings.{0} can only be built in: {1}' },
		});
		await p.construct(T0, c.id, inner(c).id, 0, 'warehouse');
	});

	it('limits simultaneous constructions and unique buildings', async () => {
		const p = player();
		const c = await p.start();
		await p.grant(T0, 'gold', 1000);
		await p.construct(T0, c.id, inner(c).id, 0, 'palace');
		await p.construct(T0, c.id, inner(c).id, 1, 'warehouse');
		await expect(p.construct(T0, c.id, inner(c).id, 2, 'barracks')).rejects.toThrow(/queue full/);
		await expect(p.construct(T0 + 60_000, c.id, inner(c).id, 3, 'palace')).rejects.toMatchObject({
			text: { text: 'buildings.Only one {0} per settlement', vars: { 0: { text: 'starter-content.Palace' } } },
		});
	});

	it('builds faster with a seat of government (palace, prefecture office); recruiting halls in the capital only', async () => {
		const p = player();
		const c = await p.start();
		for (const r of ['food', 'wood', 'stone', 'metal', 'gold']) await p.grant(T0, r, 1e6);
		const seconds = async (t: number) => inner(await p.detail(t)).slots[1].options.find((o) => o.building === 'warehouse')!.seconds;
		const before = await seconds(T0);
		await p.construct(T0, c.id, inner(c).id, 0, 'palace');
		// Once it stands (level 1): +5% construction speed in this settlement.
		const later = T0 + 30 * 86_400_000;
		expect(inner(await p.detail(later)).slots[0].current).toMatchObject({ building: 'palace', level: 1 });
		expect(await seconds(later)).toBe(Math.ceil(before / 1.05));
		// The settlement's card says where construction time comes from: the palace's +5% speed is 1/1.05 of the time.
		const slots = (await p.views(later, ['buildings.slots']))['buildings.slots'] as CardsData;
		expect(slots.header?.lines?.at(-1)?.text).toEqual({
			text: 'buildings.Construction time: {0}',
			vars: { 0: [{ text: 'stats.{0} {1}', vars: { 0: { text: 'starter-content.Palace' }, 1: '−4.8%' } }] },
		});
		// The build queue's limit on hover: its base, then each source.
		expect(slots.header?.lines?.find((l) => l.text.text === 'buildings.build queue {0}/{1}')?.hint?.[0]).toMatchObject({
			text: 'stats.Base {0}',
		});
		// The storage cap by source (the resource bar's hover text).
		expect((await p.pool(later)).capacitySources[0]).toMatchObject({ text: 'stats.Base {0}' });
		// Outer cities only at levels 1, 5, 10, 15 and 20 (statSteps): none more past 20; speed goes on, 5% a level.
		const effects = async (level: number) => {
			await p.run(later, 'buildings.setLevel', { settlement: c.id, district: inner(c).id, slot: 0, level }, true);
			return inner(await p.detail(later)).slots[0].current!.effects.stats!;
		};
		expect(await effects(1)).toMatchObject({ 'settlements.outer.tech': 1, 'buildings.speed': 5 });
		expect(await effects(4)).toMatchObject({ 'settlements.outer.tech': 1, 'buildings.speed': 20 });
		expect(await effects(5)).toMatchObject({ 'settlements.outer.tech': 2 });
		expect(await effects(25)).toMatchObject({ 'settlements.outer.tech': 5, 'buildings.speed': 125 });
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
		await expect(p.construct(T0, c.id, outer(c).id, 1, 'gold-mine')).rejects.toMatchObject({
			text: { text: 'buildings.Only one {0} per district', vars: { 0: { text: 'starter-content.Counting House' } } },
		});
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
		expect(buildings.levelCost(api, 'farm', 7)).toEqual({
			cost: { food: 880, wood: 1200, stone: 400, metal: 250, gold: 250 },
			seconds: 2100,
		});
		const g = 1.3 ** 2; // two levels past the 7-row table
		expect(buildings.levelCost(api, 'farm', 9)).toEqual({
			cost: {
				food: Math.ceil(880 * g),
				wood: Math.ceil(1200 * g),
				stone: Math.ceil(400 * g),
				metal: Math.ceil(250 * g),
				gold: Math.ceil(250 * g),
			},
			seconds: Math.ceil(2100 * 1.25 ** 2),
		});
	});

	it('resource buildings cost none of their own resource up to level 3 (GM-tunable)', async () => {
		const buildings = defaultKernel.services.get('buildings');
		const api = (over: Record<string, unknown>) => ({ config: engineContext(defaultKernel, 'x', 0, over).config }) as never;
		expect(buildings.levelCost(api({}), 'lumber-mill', 1).cost).toEqual({ stone: 40 });
		expect(buildings.levelCost(api({}), 'farm', 3).cost).toEqual({ wood: 170 });
		// From level 4 every building costs all five resources, its own included.
		expect(buildings.levelCost(api({}), 'lumber-mill', 4).cost).toEqual({ stone: 200, wood: 280, food: 120, metal: 70, gold: 70 });
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
					.addGate(async (_api, req) =>
						req.building.id === 'warehouse' && req.toLevel >= 2 ? { text: 'test-research.Requires Masonry' } : null,
					);
			},
		});
		const p = player({ 'buildings.rules': { warehouse: { cap: 1 } } }, createKernel([...plugins, gate]));
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'warehouse');
		const slot = (await p.detail(T0 + 60_000)).districts[0].slots[0];
		expect(slot.current).toMatchObject({ level: 1, cap: 1 });
		expect(slot.options[0].blocked).toEqual({ text: 'buildings.Level cap {0} reached', vars: { 0: 1 } });
		await p.run(T0 + 60_000, 'buildings.raiseCap', { settlement: c.id, district: inner(c).id, slot: 0, by: 3 }, true);
		expect((await p.detail(T0 + 60_000)).districts[0].slots[0].options[0].blocked).toEqual({ text: 'test-research.Requires Masonry' });
	});
});

describe('resource pools', () => {
	it('grow exactly at the rate they report, whatever commands run in between (no double settling)', async () => {
		const p = player();
		const c = await p.start();
		await p.construct(T0, c.id, outer(c).id, 0, 'farm');
		// Below the storage cap (growth stops there).
		const t = T0 + 30_000;
		const a = await p.pool(t);
		// Commands that settle the pool in between change nothing.
		await p.run(t + 10_000, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		await p.run(t + 20_000, 'resources.grant', { resource: 'gold', amount: 0 }, true);
		const b = await p.pool(t + 30_000);
		expect(Object.keys(a.rates).length).toBeGreaterThan(0);
		for (const r of Object.keys(a.rates)) expect(b.amounts[r] - a.amounts[r]).toBeCloseTo(a.rates[r] * 30, 6);
	});

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
		expect((await p.pool(T0 + 3600_000 + 30_000)).capacity).toBe(10_600);
	});

	it('warehouses hold more and more: linear to level 5, x1.25 a level from 6, doubling from 16', () => {
		const buildings = defaultKernel.services.get('buildings');
		const def = buildings.get('warehouse');
		expect(def.statsGrowth).toEqual([
			{ from: 6, factor: 1.25 },
			{ from: 16, factor: 2 },
		]);
		expect(stagedGrowth(10_000, 5, def.statsGrowth)).toBe(50_000);
		expect(stagedGrowth(10_000, 6, def.statsGrowth)).toBe(62_500);
		expect(stagedGrowth(10_000, 15, def.statsGrowth)).toBeCloseTo(50_000 * 1.25 ** 10);
		expect(stagedGrowth(10_000, 17, def.statsGrowth)).toBeCloseTo(50_000 * 1.25 ** 10 * 4);
	});
});

describe('outer cities', () => {
	it('fill the first ring up to the research limit; items go further, onto the second ring', async () => {
		// The ring free of the starter camps.
		const p = player({ 'player-settlements.outerCost': { food: 0 }, 'npc-camps.starterCamps': [] });
		await p.start();
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
		expect((await p.detail(T0)).nextOuter!.blocked).toEqual({ text: 'settlements.Research more to build more outer cities' });
		await expect(addOuter()).rejects.toMatchObject({ text: { text: 'settlements.Research more to build more outer cities' } });
		for (let i = 0; i < 5; i++) await addOuter(true); // items: up to 8 = the full 3x3
		const d = await p.detail(T0);
		const ring = (t: { x: number; y: number }) => Math.max(Math.abs(wrap(t.x - d.x)), Math.abs(wrap(t.y - d.y)));
		expect(d.districts.filter((x) => x.type === 'outer').map(ring)).toEqual(Array(8).fill(1));
		await addOuter(true); // ninth: second ring
		expect(ring((await p.detail(T0)).districts.at(-1)!)).toBe(2);
		// Slots: at least one per resource building and a spare, at most 13 (player-settlements.outerSlots).
		for (const x of (await p.detail(T0)).districts.filter((x) => x.type === 'outer')) {
			expect(x.slots.length).toBeGreaterThanOrEqual(6);
			expect(x.slots.length).toBeLessThanOrEqual(13);
		}
	});

	it("get more slots from the GM: one of the player's outer cities, never an inner city or someone else's", async () => {
		const p = player();
		const c = await p.start();
		const before = outer(c).slots.length;
		// The GM console's form lists the player's outer cities.
		const asGm = engineContext(defaultKernel, p.id, T0, {}, true);
		const forms = (await computeViews(defaultKernel, db, asGm, ['ui.forms'], { placement: 'gm' })).views['ui.forms'] as ResolvedForm[];
		const form = forms.find((f) => f.command === 'settlements.addSlots')!;
		expect(form.fields.find((f) => f.name === 'target')!.options!.map((o) => o.value)).toEqual([`${c.id}|${outer(c).id}`]);
		await p.run(T0, 'settlements.addSlots', { target: `${c.id}|${outer(c).id}`, count: 3 }, true);
		await p.run(T0, 'settlements.addSlots', { settlement: c.id, district: outer(c).id, count: 1 }, true);
		expect(outer(await p.detail(T0)).slots).toHaveLength(before + 4);

		await expect(p.run(T0, 'settlements.addSlots', { settlement: c.id, district: outer(c).id, count: 1 })).rejects.toMatchObject({
			code: 'unknown_command',
		});
		await expect(p.run(T0, 'settlements.addSlots', { settlement: c.id, district: inner(c).id, count: 1 }, true)).rejects.toMatchObject({
			text: { text: 'settlements.No such outer city' },
		});
		await expect(p.run(T0, 'settlements.addSlots', { settlement: c.id, district: outer(c).id, count: 0 }, true)).rejects.toMatchObject({
			code: 'bad_payload',
		});
		const q = player();
		const other = await q.start();
		await expect(
			p.run(T0, 'settlements.addSlots', { settlement: other.id, district: outer(other).id, count: 1 }, true),
		).rejects.toMatchObject({
			code: 'not_found',
		});
		expect(outer(await q.detail(T0)).slots).toHaveLength(outer(other).slots.length);
	});

	it('take a GM range of slots, [min, max] or [min, most likely, max]; refuse a decreasing one', async () => {
		const even = player({ 'player-settlements.outerSlots': [4, 4] });
		expect(outer(await even.start()).slots).toHaveLength(4);
		const peaked = player({ 'player-settlements.outerSlots': [7, 7, 7] });
		expect(outer(await peaked.start()).slots).toHaveLength(7);
		const { errors } = resolveConfig(defaultKernel, { 'player-settlements.outerSlots': [9, 6, 13] });
		expect(errors['player-settlements.outerSlots']).toMatchObject({ text: 'player-settlements.The numbers must not decrease' });
	});
});

describe('founding and the map', () => {
	it('founds a fortress across the map seam and shows it in a wrapped window', async () => {
		const p = player();
		await p.start();
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

	it('fortresses: a military one takes barracks; raised rules top up existing ones (more stays)', async () => {
		const rule = 'player-settlements.fortressSlots';
		const p = player({ [rule]: { 'fortress-military': 4 } });
		await p.start();
		let tile = { x: 0, y: 0 };
		for (let i = 0; ; i++) {
			const t = { x: wrap(300 + i * 7), y: 300 };
			if (!(await db.prepare('SELECT 1 FROM world_map_tiles WHERE x = ? AND y = ?').bind(t.x, t.y).first())) {
				tile = t;
				break;
			}
		}
		await p.run(T0, 'settlements.found', { kind: 'fortress-military', ...tile, name: 'Fort' }, true);
		const fort = (await p.mine(T0)).find((s) => s.name === 'Fort')!;
		const slots = async () => (await p.detail(T0, fort.id)).districts[0].slots.length;
		expect(await slots()).toBe(5); // the rule's 4 and the wall's
		const centre = (await p.detail(T0, fort.id)).districts[0].id;
		await p.grant(T0, 'wood', 1e6, fort.id);
		await p.grant(T0, 'stone', 1e6, fort.id);
		await p.grant(T0, 'food', 1e6, fort.id);
		await p.construct(T0, fort.id, centre, 0, 'barracks');
		await expect(p.construct(T0, fort.id, centre, 1, 'farm')).rejects.toThrow(GameError);
		// The rule goes up: the GM command (or the background task) tops it up; down again: nothing is taken away.
		(p.overrides as Record<string, unknown>)[rule] = { 'fortress-military': 15 };
		await p.run(T0, 'settlements.topUpSlots', {}, true);
		expect(await slots()).toBe(16); // the wall's slot stays on top
		(p.overrides as Record<string, unknown>)[rule] = { 'fortress-military': 10 };
		await p.run(T0, 'settlements.topUpSlots', {}, true);
		expect(await slots()).toBe(16);
		await expect(p.run(T0, 'settlements.topUpSlots', {})).rejects.toThrow(); // GM only
	});
});
