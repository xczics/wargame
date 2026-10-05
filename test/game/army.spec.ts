/** Troops and armies: training, upkeep, marches, missions and formations. */
import { describe, expect, it } from 'vitest';
import { createKernel, definePlugin } from '../../src/kernel';
import { plugins } from '../../src/plugins';
import { wrap } from '../../src/plugins/world-map';
import type {
	ArmyInfo,
	BattleFormationInfo,
	GarrisonInfo,
	PrestigeStatus,
	ResolvedForm,
	ShopStore,
	UnitNumbers,
} from '../../src/shared/api';
import type { LanesInputData, RowsData, TimersData } from '../../src/shared/ui';
import { db, T0, unitsKernel, player, inner, inbox } from '../helpers';

describe('troops', () => {
	const garrison = async (p: ReturnType<typeof player>, now: number, settlement?: string) =>
		(await p.views(now, ['troops.garrison'], settlement ? { settlement } : {}))['troops.garrison'] as GarrisonInfo;

	it('trains in batches after the barracks, and garrisons cost upkeep', async () => {
		const p = player(undefined, unitsKernel);
		const c = await p.start();
		expect((await garrison(p, T0)).trainable.find((u) => u.unit === 'militia')?.blocked).toEqual({
			text: 'test-units.Requires Barracks {0}',
			vars: { 0: 1 },
		});
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
		expect(rows.sections[0].lines).toContainEqual(
			expect.objectContaining({ text: expect.objectContaining({ text: 'troops.Upkeep: {list}/h' }) }),
		);
		expect(g.upkeep.food).toBeCloseTo(0.1);
		const pool = await p.pool(T0 + 60_000);
		expect(pool.upkeep.food).toBeCloseTo(0.1);
		// 500 - 200 (barracks) - 150 (militia) - 0.1/s for the 5 s since they arrived.
		expect(pool.amounts.food).toBeCloseTo(150 - 0.5);
	});

	it('takes over training kept before the queues plugin: the batch finishes when it would have, the plan after it', async () => {
		const p = player();
		const c = await p.start();
		// As 1.2 stored it: a batch training (with its event) and a plan waiting behind it, in troops_queue.
		const holder = `settlement:${c.id}`;
		const running = crypto.randomUUID();
		const waiting = crypto.randomUUID();
		await db.batch([
			db
				.prepare(
					'INSERT INTO troops_queue (id, settlement_id, line, seq, unit, count, cost, started_at, finishes_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
				)
				.bind(running, c.id, 'barracks', 1, 'infantry-1', 4, '{"food":40}', T0, T0 + 60_000),
			db
				.prepare(
					'INSERT INTO troops_queue (id, settlement_id, line, seq, unit, count, cost, started_at, finishes_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)',
				)
				.bind(waiting, c.id, 'barracks', 2, 'infantry-1', 3, '{"food":30}'),
			db
				.prepare('INSERT INTO timeline_events (id, entity, due_at, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
				.bind(crypto.randomUUID(), holder, T0 + 60_000, 'troops.trained', JSON.stringify({ settlementId: c.id, id: running }), T0),
		]);
		// Seen before it is due: the same two, in order.
		expect((await garrison(p, T0 + 1_000)).training.map((b) => [b.id, b.startedAt])).toEqual([
			[running, T0],
			[waiting, null],
		]);
		// Once due (the old event, then the queue's own): 4 join; the plan starts at that moment.
		const g = await garrison(p, T0 + 61_000);
		expect(g.units).toEqual([{ id: 'infantry-1', count: 4 }]);
		expect(g.training).toEqual([expect.objectContaining({ id: waiting, startedAt: T0 + 60_000 })]);
		// A command moves them for good: nothing is left in the old table.
		await p.run(T0 + 61_000, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 1 }, true);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM troops_queue WHERE settlement_id = ?').bind(c.id).first<{ n: number }>())?.n).toBe(
			0,
		);
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
		await expect(p.run(t, 'troops.cancel', { settlement: c.id, id: q[0].id })).rejects.toThrow(/started already/);
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
		expect(timers.notes).toContainEqual({
			where: 'cavalry-camp',
			text: { text: 'starter-army.Requires {0} Lv {1}', vars: { 0: { text: 'starter-army.Cavalry Camp' }, 1: 1 } },
			tone: 'muted',
		});
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
			title: {
				text: 'war-reports.Troops deserted {settlement}: out of {resource}',
				vars: { resource: { text: 'starter-content.Currency' } },
			},
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
		expect(t.find((x) => x.unit === 'infantry-2')?.blocked).toEqual({
			text: 'starter-army.Requires {0} Lv {1}',
			vars: { 0: { text: 'starter-army.Infantry Camp' }, 1: 5 },
		});
		expect(t.find((x) => x.unit === 'archer-1')?.blocked).toEqual({
			text: 'starter-army.Requires {0} Lv {1}',
			vars: { 0: { text: 'starter-army.Archer Camp' }, 1: 1 },
		});
		expect(t.some((x) => x.unit === 'infantry-5')).toBe(false);
		await expect(p.run(T0 + 1_000, 'troops.train', { settlement: c.id, unit: 'cavalry-5', count: 1 })).rejects.toMatchObject({
			text: { text: 'troops.{0} cannot be trained' },
		});

		// The training form lives in the entry of the barracks that trains them.
		const trainForm = async (type: string) =>
			((await p.views(T0 + 1_000, ['ui.forms'], { placement: 'building', settlement: c.id, type }))['ui.forms'] as ResolvedForm[]).find(
				(f) => f.command === 'troops.train',
			);
		const options = (await trainForm('barracks'))!.fields.find((f) => f.name === 'unit')!.options!.map((o) => o.value);
		expect(options).toEqual(['infantry-1']);
		// "At most n": what the settlement's resources pay for.
		expect((await trainForm('barracks'))!.fields.find((f) => f.name === 'count')!.placeholderBy?.values['infantry-1']).toMatchObject({
			text: 'troops.At most {0}',
		});
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
		const p = player({ 'buildings.speed': 1e6, 'resources.baseCapacity': 1e8 });
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'barracks');
		const at = T0 + 1_000;
		await p.run(at, 'buildings.setLevel', { settlement: c.id, district: inner(c).id, slot: 0, level: 10 }, true);
		for (const r of ['food', 'wood', 'metal', 'stone', 'gold']) await p.grant(at, r, 10_000_000);
		await p.run(at, 'troops.train', { settlement: c.id, unit: 'infantry-1', count: 5 }); // tier 1: free of quota
		const t = at + 3_600_000;
		await expect(p.run(t, 'troops.train', { settlement: c.id, unit: 'infantry-2', count: 5 })).rejects.toMatchObject({
			text: { text: 'starter-levies.Needs levy quota: {0} left (use a {1} Levy Order)', vars: { 0: 0 } },
		});
		await p.run(t, 'items.grant', { item: 'levy-infantry-2', count: 1 }, true);
		await p.run(t, 'items.use.levy-infantry-2', null);
		await p.run(t, 'troops.train', { settlement: c.id, unit: 'infantry-2', count: 5 });
		// The training form's count shows the most for the chosen unit: here the quota left, not the resources.
		const train = (
			(await p.views(t, ['ui.forms'], { placement: 'building', settlement: c.id, type: 'barracks' }))['ui.forms'] as ResolvedForm[]
		).find((f) => f.command === 'troops.train')!;
		const count = train.fields.find((f) => f.name === 'count')!;
		expect(count.placeholderBy?.field).toBe('unit');
		expect(count.placeholderBy?.values['infantry-2']).toEqual({ text: 'troops.At most {0}', vars: { 0: '995' } });
		const form = ((await p.views(t, ['ui.forms'], { placement: 'items', settlement: c.id }))['ui.forms'] as ResolvedForm[]).find(
			(f) => f.command === 'items.use.levy-infantry-2',
		);
		expect(form).toBeUndefined(); // used up
		await p.run(t, 'items.grant', { item: 'levy-infantry-3', count: 1 }, true);
		const f3 = ((await p.views(t, ['ui.forms'], { placement: 'items', settlement: c.id }))['ui.forms'] as ResolvedForm[]).find(
			(f) => f.command === 'items.use.levy-infantry-3',
		)!;
		expect(f3.description).toMatchObject({ vars: { 0: { text: 'starter-levies.Quota now: {0}', vars: { 0: 0 } } } });
		await p.run(t, 'items.use.levy-infantry-3', null);
		await expect(p.run(t + 3_600_000, 'troops.train', { settlement: c.id, unit: 'infantry-3', count: 101 })).rejects.toMatchObject({
			text: { vars: { 0: 100 } },
		});
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
						return ((await resources.amounts(api, settlements.entity(s.id))).gold ?? 0) >= count + 1000
							? null
							: { text: 'test-quota.Needs training quota' };
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
		await expect(p.run(T0, 'armies.send', { from: c.id, x: tile.x, y: tile.y, units: { spearman: 1 } })).rejects.toMatchObject({
			text: { text: 'armies.Not enough {0}', vars: { 0: { text: 'test-units.Spearman' } } },
		});

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
		await expect(
			p.run(T0, 'armies.transfer', { from: c.id, ...fortTile, units: { militia: 4 }, cargo: { wood: 100 } }),
		).rejects.toMatchObject({ text: { text: 'armies.These units can carry at most {0} supplies', vars: { 0: 80 } } });
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
		expect(back.report?.note).toEqual({ text: 'armies.Supplies delivered' });
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
		expect(forms).toEqual(expect.arrayContaining(['armies.transport', 'armies.transfer']));
		// One form both ways: supplies out, what to bring back, "fill up"; each box's "at most" counted on by the client.
		const form = (
			(await p.views(T0, ['ui.forms'], { placement: 'tile', x: String(resTile.x), y: String(resTile.y) }))['ui.forms'] as ResolvedForm[]
		).find((f) => f.command === 'armies.transport')!;
		const field = (name: string) => form.fields.find((f) => f.name === name)!;
		expect(field('cargo.stone').placeholderLive).toMatchObject({ by: 'from', values: { [c.id]: { at: T0 } } });
		expect(field('pickup.food').placeholderLive?.values['']).toMatchObject({ at: T0, amount: expect.any(Number) });
		expect(field('fill').type).toBe('checkbox');

		// There and back: unload the stone, load what was asked for, at most what the units carry (4 militia: 80).
		await p.grant(T0, 'food', 1000, mineId);
		const mineStone = (await p.pool(T0, mineId)).amounts.stone;
		await p.run(T0, 'armies.transport', {
			from: c.id,
			...resTile,
			units: { militia: 4 },
			cargo: { stone: 30 },
			'pickup.food': 60,
			'pickup.wood': 60,
		});
		const trip = (await armies(p, T0))[0];
		expect(trip.mission).toBe('transport');
		const before = (await p.pool(trip.arrivesAt, mineId)).amounts;
		await p.run(trip.arrivesAt, 'timeline.sync', { entity: `army:${trip.id}` }, true);
		const after = (await p.pool(trip.arrivesAt, mineId)).amounts;
		expect(after.stone).toBeCloseTo(mineStone + 30);
		expect(before.food - after.food).toBeCloseTo(40, 0); // 120 asked, 80 carried: scaled evenly
		expect(before.wood - after.wood).toBeCloseTo(40, 0);
		const home = (await p.pool(trip.returnsAt)).amounts.food;
		await p.run(trip.returnsAt, 'timeline.sync', { entity: `army:${trip.id}` }, true);
		expect((await p.pool(trip.returnsAt)).amounts.food).toBeCloseTo(home + 40, 0);

		// Fill up, half and half: what runs short (wood) leaves its share to the other (food).
		const t1 = trip.returnsAt + 1_000;
		await p.run(t1, 'troops.grant', { settlement: c.id, unit: 'militia', count: 60 }, true); // 60 carry 1,200
		await p.run(t1, 'armies.transport', { from: c.id, ...resTile, units: { militia: 60 }, 'pickup.food': 1, 'pickup.wood': 1, fill: true });
		const full = (await armies(p, t1))[0];
		const was = (await p.pool(full.arrivesAt, mineId)).amounts;
		await p.run(full.arrivesAt, 'timeline.sync', { entity: `army:${full.id}` }, true);
		const now = (await p.pool(full.arrivesAt, mineId)).amounts;
		expect(was.wood).toBeLessThan(600); // short of its half
		expect(was.wood - now.wood).toBeCloseTo(Math.floor(was.wood), 0);
		expect(was.food - now.food).toBeCloseTo(1200 - Math.floor(was.wood), 0);
		await expect(p.run(T0, 'armies.transport', { from: c.id, x: wrap(c.x + 30), y: c.y, units: { militia: 1 } })).rejects.toThrow(
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
		expect(failed.report?.note).toEqual({
			text: 'settling.Could not found the settlement: {0}',
			vars: { 0: { text: 'settlements.That tile is already occupied' } },
		});
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
		).rejects.toMatchObject({ text: { text: 'battle.No lane for {0}', vars: { 0: { text: 'starter-army.Infantry' } } } });
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
