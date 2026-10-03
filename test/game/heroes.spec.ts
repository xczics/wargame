/** Heroes, realms and equipment. */
import { describe, expect, it } from 'vitest';
import { createKernel, definePlugin, engineContext, GameError, seededRandom } from '../../src/kernel';
import { plugins } from '../../src/plugins';
import { wrap } from '../../src/plugins/world-map';
import type {
	ArmyInfo,
	EquipmentBag,
	HeroCandidates,
	HeroInfo,
	HeroPost,
	HeroRoles,
	ItemStack,
	MapMarker,
	RealmMail,
	RealmShop,
	RealmsOverview,
	ResolvedForm,
	SettlementDetail,
} from '../../src/shared/api';
import type { CardsData, RowsData, TimersData } from '../../src/shared/ui';
import { fightGroups, margin } from '../../src/shared/realms';
import { T0, defaultKernel, onlyLoot, unitsKernel, player, inner, inbox, outer } from '../helpers';

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
		expect(cards.cards.map((x) => x.title.text)[0]).toBe('heroes.Recruited');
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

	it('the GM can place a candidate (chosen or rolled attributes) that the player recruits at the usual price', async () => {
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
		expect((await p.pool(at)).amounts.gold).toBeCloseTo(gold - 3000); // the music house's price
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

	it('at an institute cut research time (learning) and research cost (governance, charm) by separate formulas', async () => {
		const p = player({ 'buildings.speed': 1e6, 'resources.baseCapacity': 1e7 });
		const c = await p.start();
		for (const r of ['stone', 'wood', 'food', 'metal', 'gold']) await p.grant(T0, r, 1e6);
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		await p.construct(T0, c.id, inner(c).id, 1, 'institute');
		const at = T0 + 10_000;
		await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		const [h] = await heroes(p, at);
		type Tree = { techs: { id: string; next: { cost: Record<string, number>; seconds: number } | null }[] };
		const next = async (t: number) =>
			((await p.views(t, ['research.tree']))['research.tree'] as Tree).techs.find((x) => x.id === 'economics')!.next!;
		const before = await next(at);
		await p.run(at, 'heroes.assign', { hero: h.id, duty: 'scholar', target: c.id });
		const after = await next(at);
		const timeCut = h.attrs.learning * 0.2;
		const costCut = Math.min(60, h.attrs.governance * 0.12 + h.attrs.charm * 0.04);
		// Each rounded up from the unrounded figures: within one of the rounded ones.
		expect(Math.abs(after.seconds - before.seconds * (1 - timeCut / 100))).toBeLessThanOrEqual(1);
		for (const [r, n] of Object.entries(before.cost)) expect(Math.abs(after.cost[r] - n * (1 - costCut / 100))).toBeLessThanOrEqual(1);
		expect(costCut).toBeGreaterThan(0);
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

		await expect(p.run(at, 'heroes.assign', { hero: a.id, duty: 'scholar', target: c.id })).rejects.toMatchObject({
			text: { text: 'starter-heroes.Requires {0}', vars: { 0: { text: 'starter-research.Institute' } } },
		});
		await p.run(at + 10_000, 'heroes.assign', { hero: a.id, duty: 'governor', target: c.id });
		await expect(p.run(at + 10_000, 'heroes.assign', { hero: b.id, duty: 'governor', target: c.id })).rejects.toMatchObject({
			text: { text: 'starter-heroes.At most {0} heroes here', vars: { 0: 1 } },
		});
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
			rows: [expect.objectContaining({ id: 'scholar', actions: [{ page: 'heroes', label: { text: 'starter-heroes.Assign heroes' } }] })],
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
		// The form: a table row per attribute (total, base, talent gained, bonus, points spent), then the input.
		const forms = (await p.views(at, ['ui.forms'], { placement: 'hero', hero: h.id }))['ui.forms'] as ResolvedForm[];
		const allocate = forms.find((f) => f.command === 'heroes.allocate')!;
		expect(allocate.columns).toHaveLength(7);
		const gov = h.talents!.governance ?? 0;
		expect(allocate.fields.find((f) => f.name === 'points.governance')?.cells).toEqual([
			g.attrs.governance,
			h.attrs.governance,
			2 * gov,
			0,
			0,
		]);

		// The governor's production changes with its governance: the old rate is banked first.
		await p.run(at, 'heroes.assign', { hero: h.id, duty: 'governor', target: c.id });
		await expect(p.run(at, 'heroes.allocate', { hero: h.id, points: { governance: 13 } })).rejects.toMatchObject({
			text: { text: 'heroes.Only {0} free points', vars: { 0: 12 } },
		});
		await expect(p.run(at, 'heroes.allocate', { hero: h.id, points: { luck: 1 } })).rejects.toMatchObject({
			text: { text: 'kernel.{0} is unknown', vars: { 0: 'points.luck' } },
		});
		await expect(p.run(at, 'heroes.allocate', { hero: h.id, points: { governance: -1 } })).rejects.toMatchObject({
			text: { text: 'kernel.{0} must be a whole number from {1} to {2}', vars: { 0: 'points.governance' } },
		});
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
				label: { text: 'armies.Supplies' },
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
			source: { text: 'starter-heroes.Commanding heroes' },
			stat: 'attack',
			percent: ha.attrs.might * 0.125,
			flat: undefined,
		});
		expect(battle!.modifiers.defender).toContainEqual({
			source: { text: 'starter-heroes.Defending heroes' },
			stat: 'defense',
			percent: hb.attrs.leadership * 0.125,
			flat: undefined,
		});
		expect(battle!.modifiers.defender).toContainEqual(
			expect.objectContaining({ source: { text: 'starter-heroes.Defending heroes' }, stat: 'casualty', percent: -hb.attrs.strategy * 0.2 }),
		);
		// Back home, the hero is free again.
		await a.run(army.returnsAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		expect((await heroes(a, army.returnsAt))[0].duty).toBe('idle');
	});
});

describe('realms', () => {
	it('fights with misses: a close fight can go either way, a far stronger hero always wins; the outlook comes from the margin', () => {
		const groups = [{ name: 'x', attack: 100, defense: 50, hp: 400 }];
		// 4 strikes to fell the group, which needs 4 to fell the hero: striking first, the hero just wins.
		const even = { attack: 150, defense: 60, hp: 160, recovery: 0 };
		// Without misses this is a sure win by a little (margin just above 1).
		expect(fightGroups(even, groups).every((g) => g.won)).toBe(true);
		const k = margin(even, groups);
		expect(k).toBeGreaterThan(0.95);
		expect(k).toBeLessThan(1.3);
		const wins = Array.from({ length: 200 }, (_, i) =>
			fightGroups(even, groups, 0.1, { miss: 0.15, random: seededRandom(`miss:${i}`) }).every((g) => g.won),
		).filter(Boolean).length;
		expect(wins).toBeGreaterThan(20);
		expect(wins).toBeLessThan(180);
		const strong = { attack: 1000, defense: 500, hp: 5000, recovery: 0 };
		expect(margin(strong, groups)).toBeGreaterThan(3);
		for (let i = 0; i < 50; i++) expect(fightGroups(strong, groups, 0.1, { miss: 0.15, random: seededRandom(`s:${i}`) })[0].won).toBe(true);
	});

	it('a fresh hero clears the first task of the first realm but needs levels for the rest', () => {
		const realms = defaultKernel.services.get('realms');
		const api = { config: engineContext(defaultKernel, 'x', 0).config } as never;
		const first = realms.list().find((r) => r.order === 1)!;
		const tasks = first.tasks(api);
		// A typical level-1 tavern hero (might ~60, leadership ~50, strategy ~40).
		const hero = { attack: 160, defense: 75, hp: 520, recovery: 5 };
		const cleared = (i: number) => fightGroups(hero, tasks[i].groups).every((g) => g.won);
		expect(cleared(0)).toBe(true);
		expect(cleared(tasks.length - 2)).toBe(false);
		expect(cleared(tasks.length - 1)).toBe(false);
		// Realms have their own tasks: 4-6 each, every name its own.
		const all = realms.list().map((r) => r.tasks(api));
		for (const t of all) expect(t.length).toBeGreaterThanOrEqual(4);
		for (const t of all) expect(t.length).toBeLessThanOrEqual(6);
		const names = all.flat().map((t) => t.name);
		expect(new Set(names).size).toBe(names.length);
	});

	// No luck from charm: drop counts as the task's weights say.
	const STRONG = { attack: { base: 1e6 }, defense: { base: 1e6 }, hp: { base: 1e6 }, luck: { charm: 0 } };
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

	it('are ten, 4-6 tasks each, harder and harder; only the first is open', async () => {
		const { p, hero, at } = await withHero();
		const o = await overview(p, at);
		expect(o.realms.map((r) => r.order)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(o.realms.map((r) => r.unlocked)).toEqual([true, false, false, false, false, false, false, false, false, false]);
		const [first, second] = o.realms;
		expect(first.tasks.map((t) => t.groups.length)).toEqual([5, 6, 7, 8]);
		// Each task's power (tasks.csv) on the realm's base: the first is x0.75.
		expect(first.tasks[0].groups[0]).toEqual({
			name: 'starter-realms.Bandit',
			attack: Math.round(110 * 0.75),
			defense: Math.round(50 * 0.75),
			hp: 160 * 0.75,
		});
		expect(first.tasks[3].groups.at(-1)).toMatchObject({ name: 'starter-realms.Black Wind Chief', boss: true });
		// Each realm five steps of x1.06 above the one before.
		expect(second.tasks[0].groups[0].attack).toBe(Math.round(110 * 1.06 ** 5 * 0.75));
		expect(first.tasks[0].exp[0]).toBe(20);
		// The Realms page as generic rows: the idle hero picked, each task with its expected outcome and a button.
		const list = (await p.views(at, ['realms.list']))['realms.list'] as RowsData;
		expect(list.picker).toMatchObject({ param: 'hero', selected: hero.id });
		const task = list.sections[1].rows[0];
		expect(task.actions).toEqual([
			expect.objectContaining({ command: 'realms.adventure', payload: { hero: hero.id, realm: first.id, task: 0 } }),
		]);
		expect(task.lines?.at(-1)?.text.text).toMatch(/^realms\.Outlook: /);
		expect(list.sections[2].rows).toEqual([]); // locked
		// A button per realm, the newest open one shown by default.
		expect(list.tabs).toHaveLength(10);
		expect(list.defaultTab).toBe(first.id);
		expect(list.sections[1].group).toBe(first.id);
		// The hero's card (generic cards): its lines, plus its adventure numbers from realms; "Manage" opens its forms.
		const cards = (await p.views(at, ['heroes.cards']))['heroes.cards'] as CardsData;
		const card = cards.cards.find((x) => x.id === hero.id)!;
		// The header: heroes here, all heroes and the limit (rule heroes.cap plus bonuses).
		expect(cards.header?.lines?.[0].text).toMatchObject({ text: 'heroes.{0} here · heroes {1} / {2}', vars: { 0: 1, 1: 1 } });
		expect(card.detail).toEqual({ label: { text: 'heroes.Manage' }, form: { placement: 'hero', context: { hero: hero.id } } });
		expect(card.lines?.some((l) => l.text.text.startsWith('realms.Adventure: '))).toBe(true);
		const forms = (await p.views(at, ['ui.forms'], { placement: 'hero', hero: hero.id }))['ui.forms'] as { command: string }[];
		expect(forms.map((f) => f.command).sort()).toEqual(['heroes.assign', 'heroes.dismiss', 'heroes.setHome']);
		// The hero's numbers from its attributes (hero-stats.csv).
		expect(o.heroStats[hero.id]).toEqual({
			attack: 10 + 2 * hero.attrs.might + 0.5 * hero.attrs.strategy,
			defense: 5 + 0.3 * hero.attrs.might + hero.attrs.leadership,
			hp: 100 + 2 * hero.attrs.might + 6 * hero.attrs.leadership,
			recovery: 5 + 0.05 * hero.attrs.learning + 0.05 * hero.attrs.charm,
			luck: 2 * hero.attrs.charm,
		});
		// Herbalism adds recovery.
		await p.run(at, 'research.setLevel', { tech: 'herbalism', level: 2 }, true);
		expect((await overview(p, at)).heroStats[hero.id].recovery).toBeCloseTo(o.heroStats[hero.id].recovery + 4);
		await expect(p.run(at, 'realms.adventure', { hero: hero.id, realm: 'soul-valley', task: 0 })).rejects.toThrow(/locked/);
		await expect(p.run(at, 'realms.adventure', { hero: hero.id, realm: 'black-wind', task: 5 })).rejects.toThrow(/No such task/);
	});

	it('pay out when the adventure ends: experience, the key from the hardest task, one report; the key opens the next realm', async () => {
		const { p, c, hero, at } = await withHero({ 'starter-realms.heroStats': STRONG });
		await p.run(at, 'realms.adventure', { hero: hero.id, realm: 'black-wind', task: 3 });
		const [busy] = await heroList(p, at);
		expect(busy.duty).toBe('realms.adventure');
		// Away: no other duty, no moving, no second adventure.
		await expect(p.run(at, 'heroes.assign', { hero: hero.id, duty: 'governor', target: c.id })).rejects.toThrow(/busy/);
		await expect(p.run(at, 'heroes.setHome', { hero: hero.id, settlement: c.id })).rejects.toThrow(/busy/);
		await expect(p.run(at, 'realms.adventure', { hero: hero.id, realm: 'black-wind', task: 0 })).rejects.toThrow(/idle/);
		const o = await overview(p, at);
		expect(o.adventures).toEqual([expect.objectContaining({ hero: hero.id, realm: 'black-wind', task: 3, finishesAt: at + 8 * 120_000 })]);
		// The Realms page's timers: the hero away (name as name-part keys), back at the end.
		const away = (await p.views(at, ['realms.away']))['realms.away'] as TimersData;
		expect(away.items).toEqual([
			expect.objectContaining({
				title: { text: 'realms.{hero}', vars: { hero: `${hero.surname} ${hero.given}` } },
				endsAt: at + 8 * 120_000,
			}),
		]);

		const end = at + 8 * 120_000;
		expect((await inbox(p, end - 1)).messages.filter((m) => m.kind === 'realms.report')).toHaveLength(0);
		await p.run(end, 'realms.sync');
		await p.run(end + 1, 'realms.sync'); // nothing twice
		const reports = (await inbox(p, end)).messages.filter((m) => m.kind === 'realms.report');
		expect(reports).toHaveLength(1);
		const r = reports[0].data as RealmMail;
		const perGroup = Math.round(20 * 2.2); // realm 1's last task: exp factor 2.2
		expect(r).toMatchObject({ realm: 'black-wind', task: 3, cleared: true, injured: false, exp: 8 * perGroup });
		expect(r.groups).toHaveLength(8);
		expect(r.clearRewards).toEqual([
			expect.objectContaining({ kind: 'item', name: 'starter-realms.item:realm-key-soul-valley', count: 1 }),
		]);
		// Cleared once: its possible drops show, by how often they fall; the others stay hidden.
		const tasks = (await overview(p, end)).realms[0].tasks;
		expect(tasks[0]).toMatchObject({ cleared: false });
		expect(tasks[0].drops).toBeUndefined();
		const drops = tasks[3].drops!;
		expect(tasks[3].cleared).toBe(true);
		expect(drops.common.map((d) => d.name)).toContain('starter-items.Scrap metal');
		// Equipment shows merged by set and colour: gold Azure Edge is rare in realm 1 (and there is no purple yet).
		expect(drops.rare).toContainEqual(
			expect.objectContaining({ kind: 'equipment', name: 'starter-equipment.Azure Edge set', rarity: 'gold' }),
		);
		expect([...drops.common, ...drops.uncommon, ...drops.rare].some((d) => d.rarity === 'purple')).toBe(false);
		expect(drops.clear).toEqual([expect.objectContaining({ name: 'starter-realms.item:realm-key-soul-valley' })]);
		expect(drops.common.some((d) => d.name === 'starter-items.Expansion permit')).toBe(false); // realm 1 has none
		// Levy orders are staggered by task (tasks.csv of starter-levies): realm 1's fourth task drops infantry and archer ones.
		const levies = [...drops.common, ...drops.uncommon, ...drops.rare]
			.filter((d) => d.name.startsWith('starter-levies.item:levy-'))
			.map((d) => d.name);
		expect(levies.length).toBeGreaterThan(0);
		expect(levies.every((n) => n.includes('levy-infantry-') || n.includes('levy-archer-'))).toBe(true);
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

	// Alone in the pool, a drop is worth exactly 1.
	// Only these drops, each worth 1 (weight 1 over a base weight of 1).
	const only = (...keep: string[]) => {
		const rules = onlyLoot(defaultKernel, 'realms', (id) => keep.includes(id));
		return {
			'loot.weights': { realms: { ...rules['loot.weights'].realms, ...Object.fromEntries(keep.map((id) => [id, 1])) } },
			'loot.rules': { baseWeight: 1, empty: { share: 0 } },
		};
	};

	it("drop until worth the task's loot: alone in the pool, a thing worth 1 drops twice a group for 1.2", async () => {
		const { p, hero, at } = await withHero({ 'starter-realms.heroStats': STRONG, ...only('scrap-metal') });
		await p.run(at, 'realms.adventure', { hero: hero.id, realm: 'black-wind', task: 3 });
		await p.run(at + 8 * 120_000, 'realms.sync');
		const r = (await inbox(p, at + 8 * 120_000)).messages.find((m) => m.kind === 'realms.report')!.data as RealmMail;
		// Realm 1's last task asks 1.2 a group: two draws of 1.
		expect(r.groups.map((g) => g.rewards.length)).toEqual(Array(8).fill(2));
	});

	it('luck (from charm) raises the loot a group must be worth: +200% luck, four draws of 1 for 3.6', async () => {
		const { p, hero, at } = await withHero({
			'starter-realms.heroStats': { ...STRONG, luck: { base: 200, charm: 0 } },
			...only('scrap-metal'),
		});
		await p.run(at, 'realms.adventure', { hero: hero.id, realm: 'black-wind', task: 3 });
		await p.run(at + 8 * 120_000, 'realms.sync');
		const r = (await inbox(p, at + 8 * 120_000)).messages.find((m) => m.kind === 'realms.report')!.data as RealmMail;
		expect(r.groups.map((g) => g.rewards.length)).toEqual(Array(8).fill(4));
	});

	it('can be sped up by other plugins or the GM: the adventure (or treatment) ends sooner, report and all', async () => {
		const { p, hero, at } = await withHero({ 'starter-realms.heroStats': STRONG });
		await p.run(at, 'realms.adventure', { hero: hero.id, realm: 'black-wind', task: 3 }); // 8 groups, 16 min
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
		expect(markers).toContainEqual(
			expect.objectContaining({ x: site.x, y: site.y, kind: 'realms.site', name: 'starter-realms.Black Wind Ridge' }),
		);
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
				tasks: () => [{ name: 'Poke', groups: [{ name: 'Rat', attack: 1, defense: 0, hp: 1 }], exp: [1], loot: 0.001 }], // one draw a group
				taskCount: 1,
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
		// No luck from charm: one draw per drop.
		const p = player({ 'buildings.speed': 1e6, 'starter-realms.heroStats': { luck: { charm: 0 } }, ...extra }, kernel);
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		await p.grant(T0 + 1_000, 'gold', 5000);
		await p.run(T0 + 1_000, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		const [hero] = await heroList(p, T0 + 1_000);
		return { p, c, hero, at: T0 + 1_000 };
	}

	it('drops in realms by tier, with a rolled rarity; a full bag loses the piece', async () => {
		// Only the regular sets' pieces (no items, no accessories).
		const noItems = onlyLoot(
			kernel,
			'realms',
			(id) => id.startsWith('starter-equipment.') && !id.startsWith('starter-equipment.accessory.'),
		);
		// No accessories either: only the regular sets below.
		const { p, hero, at } = await withHero({ ...noItems, 'equipment.storage': 1, 'starter-equipment.rules': { drop: { accessory: 0 } } });
		await p.run(at, 'realms.adventure', { hero: hero.id, realm: 'test-cave', task: 0 });
		await p.run(at + 120_000, 'realms.sync');
		const [piece] = (await bag(p, at + 120_000)).pieces;
		// Realm order 3 drops pieces of the sets whose ranges include it (Azure Edge, Iron Guard, Wanderer).
		expect(piece.hero).toBeNull();
		expect(['starter-equipment.Azure Edge set', 'starter-equipment.Iron Guard set', 'starter-equipment.Wanderer set']).toContain(piece.set);
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
		expect(storage.title).toEqual({ text: 'equipment.Stored here {0} / {1}', vars: { 0: 3, 1: 3 } });
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
		// A purchase says so over the whole screen, so a second tap does not buy again unnoticed.
		expect(shopCards.cards.find((x) => x.id === chest)?.actions?.[0].notice?.text).toBe('shop.Bought {0} × {1}: it is in your inventory.');
		expect(shopCards.cards.some((x) => x.id.endsWith('-white'))).toBe(false);
		// Accessory sets go by their short name: "绿色素心饰品宝箱".
		expect(shopCards.cards.find((x) => x.id === 'chest-plain-heart-green')?.title).toEqual({
			text: 'starter-equipment.item:chest-plain-heart-green',
		});
		expect(shopCards.cards.find((x) => x.id === chest)).toMatchObject({
			group: 'chests',
			rarity: 'gold',
			lines: [{ text: { vars: { n: '300' } } }, expect.anything()],
		});
		await p.run(T0, 'items.grant', { item: chest, count: 4 }, true);
		const card = ((await p.views(T0, ['items.cards']))['items.cards'] as CardsData).cards.find((x) => x.id === chest)!;
		expect(card).toMatchObject({ title: { text: 'starter-equipment.item:chest-azure-edge-gold' }, rarity: 'gold', count: 4 });
		for (let i = 0; i < 3; i++) await p.run(T0 + i, `items.use.${chest}`, { settlement: c.id });
		const pieces = (await bag(p, T0 + 3)).pieces;
		expect(pieces).toHaveLength(3);
		for (const x of pieces) expect(x).toMatchObject({ rarity: 'gold', set: 'starter-equipment.Azure Edge set', settlement: c.id });
		// Storage holds 3 without an armory: the fourth is refused and the chest kept.
		await expect(p.run(T0 + 3, `items.use.${chest}`, { settlement: c.id })).rejects.toThrow(/No room/);
		expect((await bag(p, T0 + 3)).pieces).toHaveLength(3);
		expect(((await p.views(T0 + 3, ['items.cards']))['items.cards'] as CardsData).cards.find((x) => x.id === chest)?.count).toBe(1);
	});

	it('realms drop a little yuanbao: perRealm x the realm order each time', async () => {
		const { p, hero, at } = await withHero(onlyLoot(kernel, 'realms', (id) => id === 'starter-shop.yuanbao'));
		await p.run(at, 'realms.adventure', { hero: hero.id, realm: 'test-cave', task: 0 });
		await p.run(at + 600_000, 'realms.sync');
		const report = (await inbox(p, at + 600_000)).messages.find((m) => m.kind === 'realms.report')!.data as RealmMail;
		const got = report.groups.flatMap((g) => g.rewards ?? []);
		expect(got.length).toBeGreaterThan(0);
		// The test realm is the third: 5 x 3 a time.
		for (const r of got) expect(r).toMatchObject({ kind: 'yuanbao', name: 'starter-shop.Yuanbao', count: 15 });
		const balance = ((await p.views(at + 600_000, ['shop.store']))['shop.store'] as { balance: number }).balance;
		expect(balance).toBe(15 * got.length);
	});

	it('accessories drop in colour (never white) and always give some charm', async () => {
		const { p, hero, at } = await withHero({
			...onlyLoot(kernel, 'realms', (id) => id.startsWith('starter-equipment.accessory.')),
			'equipment.storage': 50,
		});
		let t = at;
		for (let i = 0; i < 5; i++) {
			await p.run(t, 'realms.adventure', { hero: hero.id, realm: 'test-cave', task: 0 });
			t += 120_000;
			await p.run(t, 'realms.sync');
		}
		const pieces = (await bag(p, t)).pieces;
		expect(pieces).toHaveLength(5);
		for (const x of pieces) {
			expect(x.set).toBe('starter-equipment.Plain Heart set'); // the accessory set of realm 3
			expect(x.rarity).not.toBe('white');
			expect(x.stats['attr.charm']).toBeGreaterThanOrEqual(1);
		}
	});

	it('sets: minimum levels, accessories only for women (as many as their talent allows), the realm shop sells white pieces', async () => {
		const { p, c, hero, at } = await withHero();
		for (const r of ['stone', 'wood', 'food', 'metal', 'gold']) await p.grant(at, r, 100_000);
		// The realm shop: white pieces the opened realms drop (here realm 1 and this test's cave, order 3).
		const shop = async () => ((await p.views(at, ['starter-equipment.shop']))['starter-equipment.shop'] as RealmShop).offers;
		const offers = await shop();
		expect(offers.map((o) => o.set)).toContain('starter-equipment.Azure Edge set');
		expect(offers.map((o) => o.set)).not.toContain('Mountain Warden set');
		expect(offers.find((o) => o.base === 'azure-edge-weapon')!.cost).toEqual({ gold: 200 });
		await expect(p.run(at, 'starter-equipment.buy', { base: 'mountain-warden-weapon', settlement: c.id })).rejects.toThrow(/Not for sale/);
		const shopData = (await p.views(at, ['starter-equipment.shop-rows']))['starter-equipment.shop-rows'] as RowsData;
		const shopRows = shopData.sections[0].rows;
		// Every realm has its section (following the realm picked on the right); one not open yet shows its pieces, not for sale.
		const locked = shopData.sections.find((x) => x.title?.text === 'starter-equipment.{0} 🔒')!;
		expect(locked.rows.length).toBeGreaterThan(0);
		expect(locked.rows[0].actions?.[0].blocked).toEqual({ text: 'starter-equipment.Open this realm to buy its pieces.' });
		expect(shopRows.find((r) => r.id === 'azure-edge-armour')).toMatchObject({
			rarity: 'white',
			actions: [{ command: 'starter-equipment.buy', payload: { base: 'azure-edge-armour', settlement: c.id } }],
		});
		await p.run(at, 'starter-equipment.buy', { base: 'azure-edge-armour', settlement: c.id });
		const armour = (await bag(p, at)).pieces[0];
		expect(armour).toMatchObject({ rarity: 'white', minLevel: 3, set: 'starter-equipment.Azure Edge set' });
		expect(Object.keys(armour.stats).some((k) => k.startsWith('attr.'))).toBe(false); // white: no attributes
		// Level 3 needed.
		await expect(p.run(at, 'equipment.equip', { piece: armour.id, hero: hero.id })).rejects.toMatchObject({
			text: { text: 'equipment.Needs a hero of level {0}', vars: { 0: 3 } },
		});
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
		await expect(p.run(at + 1_000, 'equipment.equip', { piece: ring.id, hero: her.id })).rejects.toMatchObject({
			text: { vars: { 0: 5 } },
		});
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
		expect(report.battle!.modifiers.attacker).toContainEqual({ source: { text: 'starter-equipment.Equipment' }, stat: 'attack', flat: 10 });
		// The leading hero adds flat numbers from its attributes too (might x 2.5 x level^0.75, equipment included).
		expect(report.battle!.modifiers.attacker).toContainEqual({
			source: { text: 'starter-heroes.Commanding heroes' },
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
