/** Trade routes (docs/design/gameplay.md §17.2): a team out on a budget of stamina, walking a route, coming home. */
import { describe, expect, it } from 'vitest';
import type { EquipmentItems, GarrisonInfo, HeroInfo, ResourcePool } from '../../src/shared/api';
import type { TradeRoutesState, TradeRoutesStatic } from '../../src/shared/trade-routes';
import { csvRows, resolveConfig } from '../../src/kernel';
import { parseRoutes } from '../../src/plugins/trade-routes';
import routesCsv from '../../src/plugins/starter-trade-routes/data/routes.csv?raw';
import nodesCsv from '../../src/plugins/starter-trade-routes/data/nodes.csv?raw';
import edgesCsv from '../../src/plugins/starter-trade-routes/data/edges.csv?raw';
import storiesCsv from '../../src/plugins/starter-trade-routes/data/i18n-routes.csv?raw';
import { fightColumns } from '../../src/shared/trade-battle';
import { aimOf, type TradeBattleReport, type TradeMerchant, tradeLoss, tradeSeconds, tradeSpeed } from '../../src/shared/trade-routes';
import { T0, defaultKernel, inner, outer, player } from '../helpers';
import { budgetCost, frontAt, replay, stepTo, visible } from '../../web/plugins/trade-routes/plan';
import { figures, squad } from '../../web/plugins/trade-routes/soldiers';
import { PORTRAITS } from '../../web/plugins/starter-trade-routes/portraits';

// A small route the GM adds (rule trade-routes.custom): start, a story, a supply point, a camp of bandits.
const route = {
	routes: 'id,name,order\ntest,Test road,1',
	nodes: [
		'route,id,chapter,kind,x,y,width,enemies,pool,text',
		'test,a,1,start,0,0,1,,,',
		'test,b,1,enemy,100,0,1,infantry-1:30,,',
		'test,c,1,story,0,100,1,,,',
		'test,d,1,supply,0,200,1,,,',
		'test,e,1,supply,200,0,1,infantry-1:5,,',
		'test,f,1,boss,300,0,3,infantry-1:5 | cavalry-4:50000 | infantry-1:5 | archer-1:10,,',
	].join('\n'),
	edges: 'route,a,b\ntest,a,b\ntest,a,c\ntest,c,d\ntest,b,e\ntest,b,f',
};

async function setUp(rules: Record<string, unknown> = {}) {
	const p = player({ 'buildings.speed': 1e6, 'trade-routes.custom': route, ...rules });
	const c = await p.start();
	await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
	const at = T0 + 100_000;
	for (const r of ['food', 'wood', 'stone', 'metal', 'gold']) await p.grant(at, r, 100_000);
	await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
	const hero = async (t = at) => ((await p.views(t, ['heroes.roster']))['heroes.roster'] as HeroInfo[])[0];
	for (const [unit, count] of [
		['infantry-1', 100],
		['archer-1', 100],
		['supply-train', 5],
		['mule-cart', 2],
	] as const)
		await p.run(at, 'troops.grant', { settlement: c.id, unit, count }, true);
	const state = async (t = at) => (await p.views(t, ['trade-routes.state']))['trade-routes.state'] as TradeRoutesState;
	const garrison = async (t = at) =>
		Object.fromEntries(
			((await p.views(t, ['troops.garrison'], { settlement: c.id }))['troops.garrison'] as GarrisonInfo).units.map((u) => [u.id, u.count]),
		);
	const pool = async (t = at) => ((await p.views(t, ['resources.pool'], { settlement: c.id }))['resources.pool'] as ResourcePool).amounts;
	return { p, c, at, hero, state, garrison, pool };
}

describe('trade routes', () => {
	it('a team sets out: its upkeep for the hours paid now, the columns out of the garrison, the hero busy, stamina by the hour', async () => {
		const { p, c, at, hero, state, garrison, pool } = await setUp();
		const h = await hero();
		const before = await pool();
		const routes = await p.static<TradeRoutesStatic>(at, 'trade-routes.routes');
		expect(routes.routes.map((r) => r.id)).toContain('test');
		expect(routes.budgets).toEqual([1, 8, 24, 72]);
		expect(routes.auxiliaries.sort()).toEqual(['field-surgeon', 'supply-train']);
		await p.run(at, 'trade-routes.depart', {
			settlement: c.id,
			route: 'test',
			hours: 8,
			team: [{ hero: h.id, units: { 'infantry-1': 50 } }],
			auxiliaries: { 'supply-train': 2 },
		});
		const e = (await state()).expedition!;
		expect(e).toMatchObject({ route: 'test', node: 'a', stamina: 800, endsAt: at + 8 * 3_600_000, auxiliaries: { 'supply-train': 2 } });
		expect(await garrison()).toMatchObject({ 'infantry-1': 50, 'supply-train': 3 });
		expect((await hero()).duty).toBe('trade-routes.expedition');
		// Paid: the upkeep of what went, for eight hours.
		const after = await pool();
		expect(Object.keys(before).some((r) => after[r] < before[r])).toBe(true);
		// One team at a time; the hero is busy.
		await expect(
			p.run(at, 'trade-routes.depart', { settlement: c.id, route: 'test', hours: 1, team: [{ hero: h.id, units: { 'archer-1': 1 } }] }),
		).rejects.toThrow(/already/);
	});

	it('refuses what the rules do not allow: two families, too many men, units that may not go along, no budget like it', async () => {
		const { p, c, at, hero } = await setUp();
		const h = await hero();
		const go = (payload: Record<string, unknown>) =>
			p.run(at, 'trade-routes.depart', {
				settlement: c.id,
				route: 'test',
				hours: 1,
				team: [{ hero: h.id, units: { 'infantry-1': 10 } }],
				...payload,
			});
		await expect(go({ team: [{ hero: h.id, units: { 'infantry-1': 10, 'archer-1': 10 } }] })).rejects.toThrow(/one family/);
		await expect(go({ auxiliaries: { 'mule-cart': 1 } })).rejects.toThrow(/may not go along/);
		await expect(go({ hours: 2 })).rejects.toThrow(/budget/);
		// A hero leads level x capLevel + its attributes by their factors: here 1 man.
		const small = await setUp({ 'trade-routes.rules': { capLevel: 1, capOther: 0 }, 'trade-routes.capAttrs': { leadership: 0, charm: 0 } });
		const one = await small.hero();
		await expect(
			small.p.run(small.at, 'trade-routes.depart', {
				settlement: small.c.id,
				route: 'test',
				hours: 1,
				team: [{ hero: one.id, units: { 'infantry-1': 2 } }],
			}),
		).rejects.toMatchObject({ text: { text: 'trade-routes.This hero leads {0} men at most', vars: { 0: 1 } } });
	});

	it('walks the route: a path takes stamina, a third once both ends are cleared; a supply point once; enemies in the way', async () => {
		const { p, c, at, hero, state } = await setUp();
		const h = await hero();
		await p.run(at, 'trade-routes.depart', {
			settlement: c.id,
			route: 'test',
			hours: 1,
			team: [{ hero: h.id, units: { 'infantry-1': 10 } }],
		});
		await p.run(at, 'trade-routes.move', { node: 'c' });
		expect((await state()).expedition).toMatchObject({ node: 'c', stamina: 95 });
		expect((await state()).cleared.test).toContain('c');
		// The supply point: +100, and an hour more out.
		await p.run(at, 'trade-routes.move', { node: 'd' });
		expect((await state()).expedition).toMatchObject({ node: 'd', stamina: 190, endsAt: at + 2 * 3_600_000, supplied: ['d'] });
		// Back and forth on cleared ground: a third; the supply point gives nothing more this time out.
		await p.run(at, 'trade-routes.move', { node: 'c' });
		await p.run(at, 'trade-routes.move', { node: 'd' });
		expect((await state()).expedition!.stamina).toBeCloseTo(190 - 10 / 3, 3);
		await expect(p.run(at, 'trade-routes.move', { node: 'b' })).rejects.toThrow(/neighbouring/);
		await p.run(at, 'trade-routes.move', { node: 'c' });
		await p.run(at, 'trade-routes.move', { node: 'a' });
		await expect(p.run(at, 'trade-routes.move', { node: 'b' })).rejects.toThrow(/fight/);
	});

	it('comes home when its time is up, or when called back; what was cleared stays', async () => {
		const { p, c, at, hero, state, garrison } = await setUp();
		const h = await hero();
		await p.run(at, 'trade-routes.depart', {
			settlement: c.id,
			route: 'test',
			hours: 1,
			team: [{ hero: h.id, units: { 'infantry-1': 10 } }],
		});
		await p.run(at, 'trade-routes.move', { node: 'c' });
		const later = at + 3_600_000 + 1_000;
		await p.run(later, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		expect((await state(later)).expedition).toBeNull();
		expect((await state(later)).cleared.test).toContain('c');
		expect((await garrison(later))['infantry-1']).toBe(100);
		expect((await hero(later)).duty).toBe('idle');
		// Out again, called back at once.
		await p.run(later, 'trade-routes.depart', {
			settlement: c.id,
			route: 'test',
			hours: 8,
			team: [{ hero: h.id, units: { 'infantry-1': 10 } }],
		});
		await p.run(later, 'trade-routes.recall', null);
		expect((await state(later)).expedition).toBeNull();
		expect((await hero(later)).duty).toBe('idle');
		expect((await garrison(later))['infantry-1']).toBe(100);
	});

	it("the GM's routes are checked when set: a path to nowhere, a route with no start", () => {
		const errorOf = (custom: unknown) => resolveConfig(defaultKernel, { 'trade-routes.custom': custom }).errors['trade-routes.custom'];
		expect(errorOf(route)).toBeUndefined();
		expect(JSON.stringify(errorOf({ ...route, edges: 'route,a,b\ntest,a,z' }))).toContain('no node');
		expect(JSON.stringify(errorOf({ ...route, nodes: route.nodes.replace('test,a,1,start', 'test,a,1,story') }))).toContain('one start');
	});

	it('fights: columns trade blows in turn, the fallen front replaced from the reserve; every strike written down', () => {
		const rules = { pace: 0.5, miss: 0, maxRounds: 30 };
		const strong = [{ id: 'h', family: 'cavalry', attack: 100, defense: 50, hp: 1000 }];
		const weak = [
			{ id: 'x', attack: 10, defense: 5, hp: 60 },
			{ id: 'y', attack: 10, defense: 5, hp: 60 },
		];
		const log = fightColumns(strong, weak, 1, rules, () => 0);
		expect(log.won).toBe(true);
		// Width 1: x first, y steps up when it falls.
		expect(log.strikes.find((s) => s.fell && s.to === 'x')).toMatchObject({ next: 'y' });
		expect(log.strikes.filter((s) => s.side === 'theirs').every((s) => s.to === 'h')).toBe(true);
		expect(log.left.x).toBe(0);
		// Too strong a wall: the attackers give up after the rounds allowed.
		const lost = fightColumns(weak.slice(0, 1), [{ id: 'w', attack: 1, defense: 1e9, hp: 1e9 }], 1, { ...rules, maxRounds: 5 }, () => 0);
		expect(lost.won).toBe(false);
		// A counter: the striker's counter attack against the family it counters, the target's counter defence against
		// the family it counters (the battle's: the troops' part x 3), the plain numbers otherwise.
		const plain = fightColumns(strong, weak, 1, rules, () => 0);
		const beats = (a: string, b: string) => (a === 'cavalry' && b === 'archer') || (a === 'archer' && b === 'infantry');
		const keen = [{ ...strong[0], counterAttack: 300 }];
		const countered = fightColumns(keen, [{ ...weak[0], family: 'archer' }], 1, rules, () => 0, beats);
		// 0.5 x 300² / (300 + 5) against 0.5 x 100² / (100 + 5).
		expect(countered.strikes[0].damage).toBeCloseTo((0.5 * 300 * 300) / 305, 2);
		expect(plain.strikes[0].damage).toBeCloseTo((0.5 * 100 * 100) / 105, 2);
		const shield = fightColumns(
			[{ id: 'h', family: 'infantry', attack: 100, defense: 50, hp: 1000 }],
			[{ ...weak[0], family: 'archer', counterDefense: 95 }],
			1,
			rules,
			() => 0,
			beats,
		);
		expect(shield.strikes[0].damage).toBeCloseTo((0.5 * 100 * 100) / 195, 2);
	});

	it('damage spread: each strike within the share either way, and it does vary', () => {
		const rules = { pace: 0.5, miss: 0, maxRounds: 1 };
		const ours = [{ id: 'h', attack: 100, defense: 50, hp: 1e9 }];
		const theirs = [{ id: 'x', attack: 10, defense: 100, hp: 1e9 }];
		const base = fightColumns(ours, theirs, 1, rules, () => 0.5).strikes[0].damage;
		const seen = new Set<number>();
		for (let i = 0; i < 50; i++) {
			const r = Math.random;
			const d = fightColumns(ours, theirs, 1, { ...rules, spread: 0.15 }, r).strikes[0].damage;
			expect(d).toBeGreaterThanOrEqual(base * 0.85 - 0.01);
			expect(d).toBeLessThanOrEqual(base * 1.15 + 0.01);
			seen.add(d);
		}
		expect(seen.size).toBeGreaterThan(10);
		// The extremes of the draw are the extremes of the spread.
		expect(fightColumns(ours, theirs, 1, { ...rules, spread: 0.15 }, () => 0).strikes[0].damage).toBeCloseTo(base * 0.85, 1);
	});

	it('aim: a column strikes the enemy it counters as often as its aim says, else any; aim from the attributes', () => {
		const rules = { pace: 1e-6, miss: 0, maxRounds: 200 };
		const counters = (a: string, b: string) => a === 'cavalry' && b === 'infantry';
		const theirs = [
			{ id: 'i', family: 'infantry', attack: 0, defense: 1, hp: 1e9 },
			{ id: 'a', family: 'archer', attack: 0, defense: 1, hp: 1e9 },
		];
		const share = (aim: number) => {
			let seed = 7;
			const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
			const log = fightColumns([{ id: 'h', family: 'cavalry', attack: 1, defense: 1, hp: 1e9, aim }], theirs, 2, rules, random, counters);
			const ours = log.strikes.filter((s) => s.side === 'ours');
			return ours.filter((s) => s.to === 'i').length / ours.length;
		};
		expect(share(1)).toBe(1);
		// Aim 0: at random, about half; aim 0.5: about three quarters (half aimed, half of the rest by chance).
		expect(Math.abs(share(0) - 0.5)).toBeLessThan(0.12);
		expect(Math.abs(share(0.5) - 0.75)).toBeLessThan(0.12);
		const r = { aimAttrs: { strategy: 1 }, aimHalf: 100 } as unknown as Parameters<typeof aimOf>[0];
		expect(aimOf(r, { strategy: 100, might: 500 })).toBeCloseTo(0.5, 6);
		expect(aimOf(r, { might: 500 })).toBe(0);
		expect(aimOf(r, { strategy: 300 })).toBeCloseTo(0.75, 6);
	});

	it('fights for a node: won, cleared and moved in, stamina for the path and the fight, men lost, experience; lost, it stays', async () => {
		const { p, c, at, hero, state } = await setUp({ 'trade-routes.combat': { miss: 0 } });
		const h = await hero();
		await p.run(at, 'trade-routes.depart', {
			settlement: c.id,
			route: 'test',
			hours: 1,
			team: [{ hero: h.id, units: { 'infantry-1': 80 } }],
			auxiliaries: { 'supply-train': 1 },
		});
		await expect(p.run(at, 'trade-routes.fight', { node: 'b', heroes: [h.id, h.id] })).rejects.toThrow();
		await p.run(at, 'trade-routes.fight', { node: 'b', heroes: [h.id] });
		const battle = (await p.views(at, ['trade-routes.battle']))['trade-routes.battle'] as TradeBattleReport;
		expect(battle.log.won).toBe(true);
		expect(battle.log.strikes.length).toBeGreaterThan(0);
		const s = await state();
		expect(s.expedition).toMatchObject({ node: 'b', stamina: 100 - 15, fought: true });
		expect(s.cleared.test).toContain('b');
		const left = s.expedition!.team[0].units['infantry-1'];
		expect(left).toBe(80 - (battle.lost[h.id]['infantry-1'] ?? 0));
		// Cleared: walking back and forth now, no fight.
		await p.run(at, 'trade-routes.move', { node: 'a' });
		await p.run(at, 'trade-routes.move', { node: 'b' });
		// A supply point held by bandits: won, it gives 600 at once (and the hours to go with it).
		const before = (await state()).expedition!;
		await p.run(at, 'trade-routes.fight', { node: 'e', heroes: [h.id] });
		const won = (await state()).expedition!;
		expect(won.node).toBe('e');
		expect(won.stamina).toBeCloseTo(before.stamina - 15 + 600 + 100, 3);
		// A wall of heavy cavalry: lost, the team stays, the men it lost are gone.
		await p.run(at, 'trade-routes.move', { node: 'b' });
		const was = (await state()).expedition!.team[0].units['infantry-1'];
		await p.run(at, 'trade-routes.fight', { node: 'f', heroes: [h.id] });
		const after = (await state()).expedition!;
		expect(((await p.views(at, ['trade-routes.battle']))['trade-routes.battle'] as TradeBattleReport).log.won).toBe(false);
		expect(after.node).toBe('b');
		expect(after.team[0].units['infantry-1']).toBeLessThan(was);
		expect((await state()).cleared.test).not.toContain('f');
	});

	it('surgeons along save some of the fallen, as in any battle', async () => {
		const { p, c, at, hero } = await setUp({ 'trade-routes.combat': { miss: 0 } });
		const h = await hero();
		await p.run(at, 'troops.grant', { settlement: c.id, unit: 'field-surgeon', count: 50 }, true);
		await p.run(at, 'trade-routes.depart', {
			settlement: c.id,
			route: 'test',
			hours: 1,
			team: [{ hero: h.id, units: { 'infantry-1': 80 } }],
			auxiliaries: { 'field-surgeon': 50, 'supply-train': 1 },
		});
		await p.run(at, 'trade-routes.fight', { node: 'b', heroes: [h.id] });
		await p.run(at, 'trade-routes.fight', { node: 'f', heroes: [h.id] });
		const battle = (await p.views(at, ['trade-routes.battle']))['trade-routes.battle'] as TradeBattleReport;
		expect(battle.saved).toContainEqual(expect.objectContaining({ source: { text: 'starter-auxiliary.Field surgeons' } }));
		expect(battle.saved[0].after).toBeLessThan(battle.saved[0].before);
	});

	it('trades at a trade post: orders opened by key nodes, once a day, paid by values plus the loss, delivered when done', async () => {
		const market = {
			routes: 'id,name,order\nmarket,Market road,1',
			nodes:
				'route,id,chapter,kind,x,y,width,enemies,pool,text,unlock\nmarket,s,1,start,0,0,1,,,,\nmarket,k,1,key,0,100,1,,,,order:stone>wood:10000; loss:100',
			edges: 'route,a,b\nmarket,s,k',
		};
		const { p, c, at, hero, state, pool } = await setUp({ 'trade-routes.custom': market });
		const trade = () => p.run(at, 'trade-routes.trade', { settlement: c.id, order: 'market/k#1' });
		await expect(trade()).rejects.toThrow(/no trade post/);
		await p.construct(at, c.id, outer(c).id, 0, 'trade-post');
		const t = at + 5_000;
		const go = () => p.run(t, 'trade-routes.trade', { settlement: c.id, order: 'market/k#1' });
		await expect(go()).rejects.toThrow(/No such trade order/);
		// The key node cleared: its order is open, and its 100 points halve the loss (20% -> 10%).
		const h = await hero(t);
		await p.run(t, 'trade-routes.depart', {
			settlement: c.id,
			route: 'market',
			hours: 1,
			team: [{ hero: h.id, units: { 'infantry-1': 10 } }],
		});
		await p.run(t, 'trade-routes.move', { node: 'k' });
		expect((await state(t)).trade.lossPoints).toBe(100);
		const before = await pool(t);
		await go();
		// 10,000 wood (value 1) is 8,000 stone (value 1.25); the loss on top: / 0.9.
		expect(before.stone - (await pool(t)).stone).toBe(Math.ceil((10_000 * 1) / 1.25 / 0.9));
		const deal = (await state(t)).trade.deals[0];
		expect(deal).toMatchObject({ settlement: c.id, order: 'market/k#1', resource: 'wood', amount: 10_000, finishesAt: t + 8 * 3_600_000 });
		await expect(go()).rejects.toThrow(/today already/);
		// Done: the wood comes in.
		const done = deal.finishesAt + 1_000;
		const woodBefore = (await pool(deal.finishesAt - 1_000)).wood;
		expect((await pool(done)).wood - woodBefore).toBeCloseTo(10_000, -1);
		expect((await state(done)).trade.deals).toEqual([]);
		// The next day, again.
		await p.run(at + 86_400_000, 'trade-routes.trade', { settlement: c.id, order: 'market/k#1' });
	});

	it('trade speed: +39% a level to level 20 (an hour), then x1.22 a level; never under 3 minutes', () => {
		const r = { minutes: 480, floor: 3, perLevel: 39, upTo: 20, beyond: 1.22, loss: 0.2 };
		expect(tradeSeconds(r, 1)).toBe(480 * 60);
		expect(tradeSeconds(r, 20) / 60).toBeCloseTo(59.7, 0);
		expect(tradeSpeed(r, 21)).toBeCloseTo((8.41 * 1.22 - 1) * 100, 6);
		expect(tradeSeconds(r, 40) / 60).toBeCloseTo(4.1, 0);
		expect(tradeSeconds(r, 200)).toBeGreaterThanOrEqual(180);
		expect(tradeLoss(r, 0)).toBe(0.2);
		expect(tradeLoss(r, 400)).toBeCloseTo(0.04);
	});

	it("a merchant on the road: four goods a day, the same all day, a piece shown is the piece bought; coupons; a day's limit", async () => {
		const bazaar = {
			routes: 'id,name,order\nbazaar,Bazaar road,1',
			nodes: 'route,id,chapter,kind,x,y,width,enemies,pool,text\nbazaar,s,1,start,0,0,1,,,\nbazaar,m,1,merchant,0,100,1,,merchant,',
			edges: 'route,a,b\nbazaar,s,m',
		};
		const { p, c, at, hero } = await setUp({ 'trade-routes.custom': bazaar });
		const shown = async () => (await p.views(at, ['trade-routes.merchant']))['trade-routes.merchant'] as TradeMerchant | null;
		expect(await shown()).toBeNull();
		const h = await hero();
		await p.run(at, 'trade-routes.depart', {
			settlement: c.id,
			route: 'bazaar',
			hours: 1,
			team: [{ hero: h.id, units: { 'infantry-1': 10 } }],
		});
		await expect(p.run(at, 'trade-routes.buy', { goods: 'veteran-squad' })).rejects.toThrow(/No merchant/);
		await p.run(at, 'trade-routes.move', { node: 'm' });
		const today = (await shown())!;
		expect(today.goods).toHaveLength(4);
		expect(await shown()).toEqual(today); // the same all day
		await p.run(at, 'shop.grant', { amount: 100_000 }, true);
		for (const g of today.goods) {
			await p.run(at, 'trade-routes.buy', { goods: g.id });
			if (g.preview.kind === 'equipment') {
				// The piece bought is the one shown: its numbers.
				const items = (await p.views(at, ['equipment.items'], { settlement: c.id }))['equipment.items'] as EquipmentItems;
				expect(items.pieces.map((x) => x.stats)).toContainEqual(g.preview.stats);
			}
		}
		const once = today.goods.find((g) => g.limit === 1)!;
		await expect(p.run(at, 'trade-routes.buy', { goods: once.id })).rejects.toThrow(/Sold out/);
		await expect(p.run(at, 'trade-routes.buy', { goods: 'nothing' })).rejects.toThrow(/none of that/);
	});

	it("veterans' writs: used in a training building, veterans of what it trains; a day's speed-up of 24 hours", async () => {
		const { p, c, at, garrison } = await setUp();
		await p.construct(at, c.id, inner(c).id, 1, 'archer-camp');
		const t = at + 5_000;
		await p.run(t, 'items.grant', { item: 'veteran-ten', count: 1 }, true);
		await p.run(t, 'items.use.veteran-ten', { settlement: c.id, building: 'archer-camp' });
		expect(await garrison(t)).toMatchObject({ 'archer-5': 100, 'archer-6': 10 });
		await expect(p.run(t, 'items.use.veteran-ten', { settlement: c.id, building: 'barracks' })).rejects.toThrow();
	});
});

describe('the starter routes', () => {
	const routes = parseRoutes(routesCsv, nodesCsv, edgesCsv, (msg) => new Error(msg));
	const i18n = defaultKernel.services.get('i18n');
	const loot = defaultKernel.services.get('loot');

	it('each chapter a net closing on its boss, the way into the next (user 2026-11-16: "每章的boss同时对应\'网\'的收束节点")', () => {
		expect(routes.map((r) => r.id)).toContain('silk');
		for (const route of routes) {
			expect(route.nodes.filter((n) => n.kind === 'start')).toHaveLength(1);
			const chapters = [...new Set(route.nodes.filter((n) => n.kind !== 'start').map((n) => n.chapter))];
			expect(chapters).toEqual([1, 2, 3, 4]);
			expect(route.chapters).toHaveLength(4);
			for (const c of chapters) {
				const bosses = route.nodes.filter((n) => n.chapter === c && n.kind === 'boss');
				expect(bosses).toHaveLength(1);
				// Every path out of the chapter goes through its boss.
				const of = (id: string) => route.nodes.find((n) => n.id === id)!;
				for (const [a, b] of route.edges)
					if (of(a).kind !== 'start' && of(b).kind !== 'start' && of(a).chapter !== of(b).chapter)
						expect([a, b]).toContain(
							route.nodes.find((x) => x.kind === 'boss' && x.chapter === Math.min(of(a).chapter, of(b).chapter))!.id,
						);
				// And every node of it reaches the boss without it.
				const seen = new Set([bosses[0].id]);
				for (let grew = true; grew;) {
					grew = false;
					for (const [a, b] of route.edges)
						for (const [x, y] of [
							[a, b],
							[b, a],
						])
							if (seen.has(x) && !seen.has(y) && of(y).chapter === c && of(y).kind !== 'start') (seen.add(y), (grew = true));
				}
				expect(route.nodes.filter((n) => n.chapter === c && n.kind !== 'start').every((n) => seen.has(n.id))).toBe(true);
			}
		}
	});

	it('the people the stories show are drawn: 32x32, every letter in its palette', () => {
		const named = new Set(routes.flatMap((r) => r.nodes.flatMap((n) => (n.portrait ? [n.portrait] : []))));
		expect(named.size).toBeGreaterThan(10);
		for (const id of named) expect(PORTRAITS[id], id).toBeDefined();
		for (const [id, art] of Object.entries(PORTRAITS)) {
			expect(art.rows, id).toHaveLength(32);
			for (const row of art.rows) {
				expect(row, id).toHaveLength(32);
				for (const ch of row) if (ch !== '.') expect(art.palette[ch], `${id}: ${ch}`).toMatch(/^#[0-9a-f]{6}$/);
			}
		}
	});

	it('every text in both languages, each in its own column', () => {
		const rows = csvRows(storiesCsv);
		expect(rows.length).toBeGreaterThan(200);
		for (const r of rows) {
			expect(r['zh-CN'], r.key).toMatch(/[\u4e00-\u9fff]/);
			expect(r.en, r.key).not.toMatch(/[\u4e00-\u9fff]/);
		}
	});

	it('names, stories and chapters are written; every fight drops something; keys open orders', () => {
		for (const route of routes) {
			expect(i18n.isKey(route.name)).toBe(true);
			for (const c of route.chapters) expect(i18n.isKey(c)).toBe(true);
			for (const n of route.nodes) {
				expect(i18n.isKey(n.name!), n.id).toBe(true);
				expect(i18n.isKey(n.text!), n.id).toBe(true);
				if (n.enemies.length) expect(loot.drops(n.pool!).length, n.id).toBeGreaterThan(0);
				if (n.kind === 'key') expect(n.unlock?.orders.length, n.id).toBeGreaterThan(0);
				if (n.kind === 'merchant') expect(n.pool, n.id).toMatch(/^merchant/);
			}
		}
	});
});

describe('the trade routes in the browser', () => {
	const [silk] = parseRoutes(routesCsv, nodesCsv, edgesCsv, (msg) => new Error(msg));
	const state = (node: string | null, cleared: string[]): TradeRoutesState => ({
		expedition: node
			? {
					route: 'silk',
					settlement: 's',
					node,
					stamina: 7,
					startedAt: 0,
					endsAt: 1,
					team: [],
					auxiliaries: {},
					supplied: [],
					fought: false,
				}
			: null,
		cleared: { silk: cleared },
		trade: { used: [], lossPoints: 0, deals: [] },
	});
	const rules = {
		perHour: 100,
		edge: 5,
		clearedShare: 1 / 3,
		battle: 10,
		supplyFirst: 600,
		supplyPass: 100,
		maxHeroes: 3,
		capLevel: 100,
		capAttrs: {},
		capOther: 1,
		aimAttrs: {},
		aimHalf: 100,
	};
	const node = (id: string) => silk.nodes.find((n) => n.id === id)!;

	it('shows the places next to cleared ones, and what the team can do there (as the server would)', () => {
		const s = state('silk-0', []);
		expect(visible(s, silk, node('silk-1-n1'))).toBe(true);
		expect(visible(s, silk, node('silk-1-n4'))).toBe(false);
		expect(stepTo(s, silk, rules, node('silk-1-n1'))).toEqual({ kind: 'fight', cost: 15, short: true });
		expect(stepTo(s, silk, rules, node('silk-1-n2'))).toEqual({ kind: 'move', cost: 5, short: false });
		expect(stepTo(s, silk, rules, node('silk-1-n4'))).toBeNull();
		expect(stepTo(state('silk-1-n2', ['silk-1-n2']), silk, rules, node('silk-0'))?.cost).toBeCloseTo(5 / 3);
	});

	it('plays a fight back from its log: hp, the front and who steps up', () => {
		const log = fightColumns(
			[{ id: 'h', attack: 100, defense: 10, hp: 1000 }],
			[
				{ id: 'enemy-0', attack: 1, defense: 1, hp: 50 },
				{ id: 'enemy-1', attack: 1, defense: 1, hp: 50 },
			],
			1,
			{ pace: 1, miss: 0, maxRounds: 30 },
			() => 0.5,
		);
		expect(frontAt(log, 0)).toEqual(['enemy-0']);
		expect(frontAt(log, log.strikes.length)).toEqual([]);
		// The log's damage is rounded to cents: near enough to draw.
		for (const [id, hp] of Object.entries(replay(log, log.strikes.length))) expect(hp).toBeCloseTo(log.left[id], 0);
		const stepUp = log.strikes.findIndex((s) => s.next) + 1;
		expect(frontAt(log, stepUp)).toEqual(['enemy-1']);
	});

	it('works out the budget as the server charges it; squads thin out with their hp', () => {
		const catalog = { a: { upkeep: { food: 0.001 } }, b: { upkeep: { food: 0.0005, gold: 0.0001 } } } as never;
		expect(budgetCost({ a: 100, b: 10 }, catalog, 8, 0.9)).toEqual({
			food: Math.ceil(100 * 0.001 * 3600 * 8 * 0.9 + 10 * 0.0005 * 3600 * 8 * 0.9),
			gold: Math.ceil(10 * 0.0001 * 3600 * 8 * 0.9),
		});
		expect([figures(1000, 1000), figures(1, 1000), figures(0, 1000)]).toEqual([6, 1, 0]);
		const s = squad('cavalry', 'theirs', 6);
		expect(s.layers).toHaveLength(6);
		for (const l of s.layers) expect(l.sprite.x + l.sprite.rows[0].length).toBeLessThanOrEqual(s.box[2]);
	});
});
