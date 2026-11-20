/** Trade routes (docs/design/gameplay.md §17.2): a team out on a budget of stamina, walking a route, coming home. */
import { describe, expect, it } from 'vitest';
import type { EquipmentItems, GarrisonInfo, HeroInfo, ResourcePool } from '../../src/shared/api';
import type { TradeRoutesState, TradeRoutesStatic } from '../../src/shared/trade-routes';
import { csvRows, resolveConfig } from '../../src/kernel';
import { parseRoutes } from '../../src/plugins/trade-routes';
import routesCsv from '../../src/plugins/starter-trade-routes/data/routes.csv?raw';
import nodesCsv from '../../src/plugins/starter-trade-routes/data/nodes.csv?raw';
import edgesCsv from '../../src/plugins/starter-trade-routes/data/edges.csv?raw';
import featuresCsv from '../../src/plugins/starter-trade-routes/data/features.csv?raw';
import storiesCsv from '../../src/plugins/starter-trade-routes/data/i18n-routes.csv?raw';
import { fightColumns } from '../../src/shared/trade-battle';
import {
	aimOf,
	fightable,
	type TradeBattleReport,
	type TradeMerchant,
	travelPath,
	tradeLoss,
	tradeSeconds,
	tradeSpeed,
} from '../../src/shared/trade-routes';
import { T0, defaultKernel, inner, outer, player } from '../helpers';
import { listOnDuty, overviewOnDuty, stateOnDuty } from '../../src/shared/duties';
import { garrisonMoved, stateMoved } from '../../src/shared/troops';
import type { HeroesState, RealmsOverview, TroopsState, UnitCatalog } from '../../src/shared/api';
import { boughtOne, teamMen } from '../../web/plugins/trade-routes/told';
import { budgetCost, frontAt, reachTo, replay, stepTo, visible } from '../../web/plugins/trade-routes/plan';
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

async function setUp(rules: Record<string, unknown> = {}, { post = true } = {}) {
	const p = player({ 'buildings.speed': 1e6, 'trade-routes.custom': route, ...rules });
	const c = await p.start();
	await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
	const at = T0 + 100_000;
	for (const r of ['food', 'wood', 'stone', 'metal', 'gold']) await p.grant(at - 10_000, r, 100_000);
	// Teams set out from a trade post.
	if (post) await p.construct(at - 10_000, c.id, outer(c).id, 0, 'trade-post');
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

	it('sets out only from a settlement with a trade post, and with idle heroes only (one in office stays)', async () => {
		const { p, c, at, hero } = await setUp({}, { post: false });
		const h = await hero();
		const go = (t: number) =>
			p.run(t, 'trade-routes.depart', { settlement: c.id, route: 'test', hours: 1, team: [{ hero: h.id, units: { 'infantry-1': 10 } }] });
		await expect(go(at)).rejects.toThrow(/no trade post/);
		await p.construct(at, c.id, outer(c).id, 0, 'trade-post');
		const t = at + 5_000;
		await p.run(t, 'heroes.assign', { hero: h.id, duty: 'governor', target: c.id });
		await expect(go(t)).rejects.toThrow(/Only idle heroes/);
		await p.run(t, 'heroes.assign', { hero: h.id, duty: 'idle', target: null });
		await go(t);
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
		// Called back with nothing spent: home at once.
		await p.run(later, 'trade-routes.recall', null);
		expect((await state(later)).expedition).toBeNull();
		expect((await hero(later)).duty).toBe('idle');
		expect((await garrison(later))['infantry-1']).toBe(100);
		// Out again: what it spent stands for time (user 2026-11-20: "召回时不可秒召回"), 100 stamina an hour: a to c (both
		// cleared: a third of 5) and c to d (5) = 4 minutes from setting out; until then it is on its way home, doing nothing.
		await p.run(later, 'trade-routes.depart', {
			settlement: c.id,
			route: 'test',
			hours: 8,
			team: [{ hero: h.id, units: { 'infantry-1': 10 } }],
		});
		await p.run(later, 'trade-routes.move', { node: 'c' });
		await p.run(later, 'trade-routes.move', { node: 'd' });
		await p.run(later + 60_000, 'trade-routes.recall', null);
		const back = (await state(later + 60_000)).expedition!;
		expect(back.recalled).toBe(true);
		expect(back.stamina).toBe(0);
		expect(Math.abs(back.endsAt - (later + 4 * 60_000))).toBeLessThan(1_000); // what d's stores gave counts on both sides
		await expect(p.run(later + 60_000, 'trade-routes.move', { node: 'c' })).rejects.toMatchObject({ code: 'blocked' });
		await expect(p.run(later + 60_000, 'trade-routes.recall', null)).rejects.toMatchObject({ code: 'blocked' });
		expect((await hero(later + 60_000)).duty).not.toBe('idle');
		const home = later + 4 * 60_000 + 1_000;
		await p.run(home, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		expect((await state(home)).expedition).toBeNull();
		expect((await hero(home)).duty).toBe('idle');
		expect((await garrison(home))['infantry-1']).toBe(100);
	});

	it('a fight may open a trade order for good: one the player has not got, then none when all are held', async () => {
		const { p, at, state } = await setUp();
		const lines = await p.probe(at, async (api, k) => {
			const tr = k.services.get('tradeRoutes');
			const first = await tr.unlockOrder(api, api.playerId, ['drop-1-stone-wood'], () => 0);
			const again = await tr.unlockOrder(api, api.playerId, ['drop-1-stone-wood'], () => 0);
			const unknown = await tr.unlockOrder(api, api.playerId, ['no-such-order'], () => 0);
			return { first, again, unknown };
		});
		expect(lines.first).toMatchObject([{ kind: 'trade-order', label: { text: 'trade-routes.Trade order: {0} {1} a day, for {2}' } }]);
		expect(lines.again).toEqual([]);
		expect(lines.unknown).toEqual([]);
		// A probe writes nothing: through a command's write it is the player's for good (the fight's loot does that).
		expect((await state(at)).trade.unlocked).toEqual([]);
		const routes = await p.static<TradeRoutesStatic>(at, 'trade-routes.routes');
		expect(routes.orders.some((o) => o.id === 'drop-1-stone-wood')).toBe(true);
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

	it("surgeons bring back a share of each round's fallen as the fight goes; those count for promotions", async () => {
		const hard = {
			routes: 'id,name,order\nhard,Hard road,1',
			nodes: 'route,id,chapter,kind,x,y,width,enemies,pool,text\nhard,s,1,start,0,0,1,,,\nhard,x,1,enemy,0,100,1,cavalry-1:130,,',
			edges: 'route,a,b\nhard,s,x',
		};
		const { p, c, at, hero, state } = await setUp({ 'trade-routes.custom': hard, 'trade-routes.combat': { miss: 0, spread: 0 } });
		const h = await hero();
		await p.run(at, 'troops.grant', { settlement: c.id, unit: 'field-surgeon', count: 50 }, true);
		await p.run(at, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 400 }, true);
		await p.run(at, 'trade-routes.depart', {
			settlement: c.id,
			route: 'hard',
			hours: 1,
			team: [{ hero: h.id, units: { 'infantry-1': 300 } }],
			auxiliaries: { 'field-surgeon': 50, 'supply-train': 1 },
		});
		await p.run(at, 'trade-routes.fight', { node: 'x', heroes: [h.id] });
		const report = (await p.views(at, ['trade-routes.battle']))['trade-routes.battle'] as TradeBattleReport;
		// At the rounds' ends, hp brought back (strikes marked heal), and the report says how many stood up again.
		expect(report.log.strikes.some((s) => s.heal)).toBe(true);
		expect(report.log.healed?.[h.id]).toBeGreaterThan(0);
		const saved = report.saved.find((x) => x.source.text === 'starter-auxiliary.Field surgeons');
		expect(saved!.after).toBeLessThan(saved!.before);
		// The fallen who stood up count for promotions: more promoted than were lost for good.
		const up = (report.promoted ?? []).reduce((a, x) => a + x.count, 0);
		expect(up).toBe(Math.min(saved!.before, 300 - saved!.after));
		expect((await state(at)).expedition!.team[0].units['infantry-2']).toBe(up);
	});

	it('trades at a trade post: orders opened by key nodes, once a day, paid by values plus the loss, delivered when done', async () => {
		const market = {
			routes: 'id,name,order\nmarket,Market road,1',
			nodes:
				'route,id,chapter,kind,x,y,width,enemies,pool,text,unlock\nmarket,s,1,start,0,0,1,,,,\nmarket,k,1,key,0,100,1,,,,order:stone>wood:10000; loss:100',
			edges: 'route,a,b\nmarket,s,k',
		};
		const { p, c, at, hero, state, pool } = await setUp({ 'trade-routes.custom': market }, { post: false });
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
		// What first turns up somewhere on the routes is on no shelf before that place is won.
		const fresh = /^(veteran-|build-order-xl|drill-order-xl|study-order-xl|rebirth-pill)/;
		expect(today.goods.filter((g) => fresh.test(g.id))).toEqual([]);
		await p.construct(at, c.id, inner(c).id, 2, 'armory'); // room for the pieces bought
		const t = at + 10_000;
		await p.run(t, 'shop.grant', { amount: 100_000 }, true);
		for (const g of today.goods) {
			await p.run(t, 'trade-routes.buy', { goods: g.id });
			if (g.preview.kind === 'equipment') {
				// The piece bought is the one shown: its numbers.
				const items = (await p.views(t, ['equipment.items'], { settlement: c.id }))['equipment.items'] as EquipmentItems;
				expect(items.pieces.map((x) => x.stats)).toContainEqual(g.preview.stats);
			}
		}
		const once = today.goods.find((g) => g.limit === 1)!;
		await expect(p.run(t, 'trade-routes.buy', { goods: once.id })).rejects.toThrow(/Sold out/);
		await expect(p.run(t, 'trade-routes.buy', { goods: 'nothing' })).rejects.toThrow(/none of that/);
	});

	it('promotes as every battle does: the fallen of a won fight raise survivors of their tier, in the columns', async () => {
		// A fight won at a cost: cavalry, who counter the infantry, fewer of them.
		const hard = {
			routes: 'id,name,order\nhard,Hard road,1',
			nodes: `route,id,chapter,kind,x,y,width,enemies,pool,text\nhard,s,1,start,0,0,1,,,\nhard,x,1,enemy,0,100,1,cavalry-1:42,,`,
			edges: 'route,a,b\nhard,s,x',
		};
		const { p, c, at, hero, state } = await setUp({ 'trade-routes.custom': hard, 'trade-routes.combat': { miss: 0, spread: 0 } });
		const h = await hero();
		await p.run(at, 'trade-routes.depart', {
			settlement: c.id,
			route: 'hard',
			hours: 1,
			team: [{ hero: h.id, units: { 'infantry-1': 80 } }],
		});
		await p.run(at, 'trade-routes.fight', { node: 'x', heroes: [h.id] });
		const report = (await p.views(at, ['trade-routes.battle']))['trade-routes.battle'] as TradeBattleReport;
		expect(report.log.won).toBe(true);
		const fell = report.lost[h.id]['infantry-1'] ?? 0;
		expect(fell).toBeGreaterThan(0);
		// Tier 1 to 2: one fallen comrade a man (the battle's own rule), no more than the survivors.
		const up = report.promoted?.find((x) => x.from === 'infantry-1' && x.to === 'infantry-2');
		expect(up?.count).toBe(Math.min(fell, 80 - fell));
		const team = (await state(at)).expedition!.team[0].units;
		expect(team['infantry-2']).toBe(up!.count);
		expect(team['infantry-1']).toBe(80 - fell - up!.count);
	});

	it('travels over opened ground in one go: the shortest way, a third of the stamina a path, supply points giving on the way', async () => {
		const { p, c, at, hero, state } = await setUp();
		const h = await hero();
		const out = (t: number) =>
			p.run(t, 'trade-routes.depart', { settlement: c.id, route: 'test', hours: 1, team: [{ hero: h.id, units: { 'infantry-1': 10 } }] });
		await out(at);
		await p.run(at, 'trade-routes.move', { node: 'c' });
		await p.run(at, 'trade-routes.move', { node: 'd' });
		await p.run(at, 'trade-routes.recall', null);
		const later = at + 3_600_000;
		await p.run(later, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		// Out again: a to d over c, both won (two paths at a third); d gives as passing does.
		await out(later);
		await expect(p.run(later, 'trade-routes.travel', { node: 'b' })).rejects.toThrow(/No way/); // b is not won
		await p.run(later, 'trade-routes.travel', { node: 'd' });
		const e = (await state(later)).expedition!;
		expect(e.node).toBe('d');
		expect(e.supplied).toEqual(['d']);
		expect(e.stamina).toBeCloseTo(100 - 10 / 3 + 100, 2);
	});

	it('a lair is fought again every time out, once a time out, where the team stands too', async () => {
		const den = {
			routes: 'id,name,order\nden,Den road,1',
			nodes: 'route,id,chapter,kind,x,y,width,enemies,pool,text\nden,s,1,start,0,0,1,,,\nden,l,1,lair,0,100,1,infantry-1:3,,',
			edges: 'route,a,b\nden,s,l',
		};
		const { p, c, at, hero, state } = await setUp({ 'trade-routes.custom': den, 'trade-routes.combat': { miss: 0 } });
		const h = await hero();
		const out = (t: number) =>
			p.run(t, 'trade-routes.depart', { settlement: c.id, route: 'den', hours: 1, team: [{ hero: h.id, units: { 'infantry-1': 80 } }] });
		await out(at);
		await p.run(at, 'trade-routes.fight', { node: 'l', heroes: [h.id] });
		const won = (await state(at)).expedition!;
		expect(won.node).toBe('l');
		expect(won.raided).toEqual(['l']);
		// Once a time out.
		await expect(p.run(at, 'trade-routes.fight', { node: 'l', heroes: [h.id] })).rejects.toThrow(/Nothing to fight/);
		await p.run(at, 'trade-routes.recall', null);
		const later = at + 3_600_000;
		await p.run(later, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		// The next time out it is there again: fought from beside it, then (another time) where the team stands.
		await out(later);
		await p.run(later, 'trade-routes.fight', { node: 'l', heroes: [h.id] });
		const again = (await state(later)).expedition!;
		expect(again.raided).toEqual(['l']);
		expect(again.stamina).toBeCloseTo(100 - 5 / 3 - 10, 2); // both ends won: a third of the path
	});

	it('a thing new to the routes drops only once the place it first turns up at is won', async () => {
		const { p, at } = await setUp();
		const counts = await p.probe(at, async (api, k) => {
			const loot = k.services.get('loot');
			const roll = async (cleared: string[]) => {
				let n = 0;
				for (let i = 0; i < 300; i++) {
					const occasion = { playerId: api.playerId, route: 'silk', node: 'x', chapter: 1, settlement: 's', cleared: new Set(cleared) };
					const random = (() => {
						let seed = i + 1;
						return () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
					})();
					const ids = await loot.roll(api, 'starter-trade-routes.silk-1', occasion, 3, random);
					n += ids.filter((id) => id === 'veteran-squad').length;
				}
				return n;
			};
			const prize = (
				k.services
					.get('tradeRoutes')
					.routes(api)
					.find((r) => r.id === 'silk')?.nodes ?? []
			).map((n) => n.id);
			return { before: await roll([]), after: await roll(prize.map((id) => `silk/${id}`)) };
		});
		expect(counts.before).toBe(0);
		expect(counts.after).toBeGreaterThan(0);
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
	const routes = parseRoutes(routesCsv, nodesCsv, edgesCsv, (msg) => new Error(msg), featuresCsv);
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

	it('about a hundred places a chapter on its own land; lairs on branches of their own; each new thing turns up once', () => {
		const nodesRows = csvRows(nodesCsv);
		for (const route of routes)
			for (let c = 1; c <= 4; c++) {
				const places = route.nodes.filter((n) => n.chapter === c && n.kind !== 'start');
				expect(places.length, `${route.id} ${c}`).toBeGreaterThanOrEqual(100);
				expect(route.features?.filter((f) => f.chapter === c).length, `${route.id} ${c}`).toBeGreaterThan(2);
				// A lair is a dead end: the boss is reached from the way in without it ("不要占据必经之路").
				for (const lair of places.filter((n) => n.kind === 'lair'))
					expect(
						route.edges.filter(([a, b]) => a === lair.id || b === lair.id),
						lair.id,
					).toHaveLength(1);
				expect(places.filter((n) => n.kind === 'lair').length, `${route.id} ${c}`).toBeGreaterThanOrEqual(2);
			}
		// The things new to the routes: each first turns up at one place.
		const prizes = nodesRows.filter((n) => n.prize).map((n) => n.prize);
		expect(new Set(prizes).size).toBe(prizes.length);
		expect(prizes.sort()).toEqual(
			[
				'veteran-squad',
				'veteran-ten',
				'veteran-company',
				'veteran-battalion',
				'veteran-camp',
				'veteran-army',
				'build-order-xl',
				'drill-order-xl',
				'study-order-xl',
				'rebirth-pill',
			].sort(),
		);
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
				// Every place is guarded (user 2026-11-20): all but the start fight for a loot pool; merchants sell from `goods`.
				if (n.kind !== 'start') expect(n.enemies.length, n.id).toBeGreaterThan(0);
				if (n.kind === 'merchant') expect(n.goods, n.id).toMatch(/^merchant/);
			}
		}
	});
});

describe('the trade routes in the browser', () => {
	// A small route: a start, a camp (b) and a story (c) next to it, a lair (e) past b, a place (d) past c, f past d.
	const [silk] = parseRoutes(
		'id,name,order\nsilk,Silk,1',
		[
			'route,id,chapter,kind,x,y,width,enemies',
			'silk,silk-0,1,start,0,0,1,',
			'silk,b,1,enemy,1,0,1,infantry-1:5',
			'silk,c,1,story,0,1,1,infantry-1:5',
			'silk,d,1,enemy,0,2,1,infantry-1:5',
			'silk,e,1,lair,2,0,1,infantry-1:5',
			'silk,f,1,enemy,0,3,1,infantry-1:5',
		].join('\n'),
		'route,a,b\nsilk,silk-0,b\nsilk,silk-0,c\nsilk,c,d\nsilk,b,e\nsilk,d,f',
		(msg) => new Error(msg),
	);
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
					raided: [],
					fought: false,
				}
			: null,
		cleared: { silk: cleared },
		trade: { used: [], unlocked: [], lossPoints: 0, deals: [] },
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
		expect(visible(s, silk, node('b'))).toBe(true);
		expect(visible(s, silk, node('d'))).toBe(false);
		expect(stepTo(s, silk, rules, node('b'))).toEqual({ kind: 'fight', cost: 15, short: true });
		// A story place is guarded too: fought for, not walked into.
		expect(stepTo(s, silk, rules, node('c'))).toEqual({ kind: 'fight', cost: 15, short: true });
		expect(stepTo(s, silk, rules, node('d'))).toBeNull();
		expect(stepTo(state('c', ['c']), silk, rules, node('silk-0'))?.cost).toBeCloseTo(5 / 3);
	});

	it('finds the way over opened ground: a place won far off travelled to, one not won fought from beside it', () => {
		const s = { ...state('b', ['b', 'c', 'd']), expedition: { ...state('b', []).expedition!, stamina: 100 } };
		// b to d: back to the start, c, d (three paths at a third).
		expect(travelPath(silk, (n) => ['silk-0', 'b', 'c', 'd'].includes(n), 'b', 'd', rules)).toEqual({
			path: ['silk-0', 'c', 'd'],
			cost: 5,
		});
		expect(reachTo(s, silk, rules, node('d'))).toMatchObject({ kind: 'travel', via: 3, short: false });
		expect(reachTo(s, silk, rules, node('d'))!.cost).toBeCloseTo(5);
		// f, past d, not won: travel to d, then fight (a full path and the fight).
		expect(reachTo(s, silk, rules, node('f'))).toMatchObject({ kind: 'fight', via: 3, from: 'd' });
		expect(reachTo(s, silk, rules, node('f'))!.cost).toBeCloseTo(5 + 5 + 10);
		// No way over ground not won.
		expect(travelPath(silk, (n) => ['silk-0', 'b'].includes(n), 'b', 'd', rules)).toBeNull();
	});

	it('a lair won is fought again every time out, once: where the team stands too', () => {
		expect(fightable(node('e'), true, [])).toBe(true);
		expect(fightable(node('e'), true, ['e'])).toBe(false);
		expect(fightable(node('b'), true, [])).toBe(false);
		const at = { ...state('e', ['b', 'e']), expedition: { ...state('e', []).expedition!, stamina: 100 } };
		expect(stepTo(at, silk, rules, node('e'))).toEqual({ kind: 'fight', cost: 10, short: false });
		const done = { ...at, expedition: { ...at.expedition!, raided: ['e'] } };
		expect(stepTo(done, silk, rules, node('e'))).toBeNull();
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

/** Numbers to nine places (upkeep worked out another way differs in the last digits). */
const rounded = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x: unknown) => (typeof x === 'number' ? Math.round(x * 1e9) / 1e9 : x)));

describe("what the trade routes' commands tell the browser's data", () => {
	it('setting out and coming home at once: the patched garrisons and heroes are what the server has then', async () => {
		const { p, c, at, hero } = await setUp();
		const h = await hero();
		const ids = ['troops.state', 'troops.garrison', 'heroes.list', 'heroes.state', 'realms.overview'];
		const held = async () => p.views(at, ids, { settlement: c.id });
		const catalog = await p.static<UnitCatalog>(at, 'troops.units');
		const team = [{ hero: h.id, units: { 'infantry-1': 10 } }];
		const auxiliaries = { 'supply-train': 1 };
		const before = await held();
		await p.run(at, 'trade-routes.depart', { settlement: c.id, route: 'test', hours: 8, team, auxiliaries });
		const after = await held();
		const men = teamMen(team, auxiliaries);
		expect(rounded(stateMoved(before['troops.state'] as TroopsState, c.id, men, catalog))).toEqual(rounded(after['troops.state']));
		expect(rounded(garrisonMoved(before['troops.garrison'] as GarrisonInfo, c.id, men, catalog))).toEqual(
			rounded(after['troops.garrison']),
		);
		const name = (before['troops.state'] as TroopsState).garrisons.find((g) => g.settlement === c.id)!.name;
		const duty = { duty: 'trade-routes.expedition', target: c.id, targetName: name };
		const ids1 = new Set([h.id]);
		expect(listOnDuty(before['heroes.list'] as HeroInfo[], ids1, duty)).toEqual(after['heroes.list']);
		expect(stateOnDuty(before['heroes.state'] as HeroesState, ids1, duty)).toEqual(after['heroes.state']);
		expect(overviewOnDuty(before['realms.overview'] as RealmsOverview, ids1, duty)).toEqual(after['realms.overview']);
		// Called home with nothing spent: back at once, as it was.
		await p.run(at, 'trade-routes.recall', null);
		const home = await held();
		const back = Object.fromEntries(Object.entries(men).map(([u, n]) => [u, -n]));
		expect(rounded(stateMoved(after['troops.state'] as TroopsState, c.id, back, catalog))).toEqual(rounded(home['troops.state']));
		expect(listOnDuty(after['heroes.list'] as HeroInfo[], ids1, { duty: 'idle', target: null })).toEqual(home['heroes.list']);
	});

	it('a merchant sells one more of its goods', () => {
		const m: TradeMerchant = {
			node: 'm',
			goods: [{ id: 'x', price: 5, limit: 2, bought: 0, preview: { kind: 'item', name: 'k', item: 'x' } }],
		};
		expect(boughtOne(m, 'x')!.goods[0].bought).toBe(1);
		expect(boughtOne(m, 'y')).toBe(m);
		expect(boughtOne(null, 'x')).toBeNull();
	});
});
