// What the browser does to the data it holds when a command of the items, shop, mail, puzzles and rewards plugins went
// through (user 2026-11-20: "你告诉前端成功了，前端不就能更新了吗？"): the pure patch functions, checked against what the
// server does where it is cheap to run.
import { expToNextOf, type HeroGrowth, withExp } from '../../src/shared/heroes';
import { describe, expect, it } from 'vitest';
import type {
	BuildingsState,
	FormPatches,
	HeroInfo,
	MailInbox,
	PuzzleHolding,
	PuzzleProgress,
	RealmsOverview,
	ResolvedForm,
	ShopWallet,
	TroopsState,
} from '../../src/shared/api';
import { type ClientViewGet, partsAt } from '../../src/shared/client-views';
import { counted } from '../../web/plugins/items/patches';
import { claimed } from '../../web/plugins/mail/patches';
import { albumClaimed, claimedPuzzle, exchanged } from '../../web/plugins/puzzles/patches';
import { applyRewards } from '../../web/plugins/rewards/apply';
import { bought, granted, priceOf } from '../../web/plugins/shop/patches';
import { quotaChanged } from '../../web/plugins/starter-levies/patches';
import {
	buildingRazed,
	buildingsMoved,
	constructionSooner,
	healed,
	renamedTo,
	respecced,
	repeatsAfter,
	truce,
} from '../../web/plugins/starter-items/patches';
import { clientParts } from '../../web/views';
import { T0, inner, player } from '../helpers';

const buildings = (over: Partial<BuildingsState> = {}): BuildingsState => ({
	settlement: { id: 's1', kind: 'capital', name: { text: 'x' }, x: 0, y: 0, garrison: true, districts: [] },
	slots: [
		{ district: 'd', slot: 0, building: 'farm', level: 3, cap: 20 },
		{ district: 'd', slot: 1, building: 'quarry', level: 2, cap: 20 },
	],
	construction: [{ district: 'd', slot: 1, building: 'quarry', targetLevel: 3, startedAt: T0, finishesAt: T0 + 3_600_000 }],
	queue: { used: 1, size: 2, breakdown: { base: 2, parts: [] } as never },
	time: { factor: 1, parts: [] },
	counters: {},
	effects: { 'd/0': { now: {}, next: {} } as never, 'd/1': { now: {}, next: {} } as never },
	...over,
});

describe('items in the browser', () => {
	it('an item used comes off the inventory, a GM gift goes on; none left is not listed (as the server sends it)', () => {
		expect(counted({ a: 2, b: 1 }, 'a', -1)).toEqual({ a: 1, b: 1 });
		expect(counted({ a: 2, b: 1 }, 'b', -1)).toEqual({ a: 2 });
		expect(counted({ a: 2 }, 'c', 3)).toEqual({ a: 2, c: 3 });
		expect(counted({ a: 2 }, 'a', -5)).toEqual({});
	});

	it('the shop: paid, counted towards today, and a GM grant never below zero', () => {
		const w: ShopWallet = { balance: 100, today: { x: 1 } };
		expect(priceOf({ cards: [{ id: 'x', needs: [{ counter: 'yuanbao', amount: 30 }] }] } as never, 'x')).toBe(30);
		expect(bought(w, 'x', 2, 30)).toEqual({ balance: 40, today: { x: 3 } });
		expect(granted(w, -500.7)).toEqual({ balance: 0, today: { x: 1 } });
	});

	it('speed-ups, moves and razing in the City page held', () => {
		const s = buildings();
		const sped = constructionSooner(s, 's1', { district: 'd', slot: 1 }, 900, T0 + 1_000);
		expect(sped.finishesAt).toBe(T0 + 3_600_000 - 900_000);
		// Never before now: done now (the caller asks the server again).
		expect(constructionSooner(s, 's1', { district: 'd', slot: 1 }, 1e9, T0 + 1_000).finishesAt).toBe(T0 + 1_000);
		expect(constructionSooner(s, 'other', { district: 'd', slot: 1 }, 900, T0).state).toBe(s);

		const moved = buildingsMoved(s, 's1', 'd', 0, 5, false)!;
		expect(moved.slots.map((x) => [x.slot, x.building])).toEqual([
			[5, 'farm'],
			[1, 'quarry'],
		]);
		expect(Object.keys(moved.effects).sort()).toEqual(['d/1', 'd/5']);
		const swapped = buildingsMoved(s, 's1', 'd', 0, 1, true)!;
		expect(swapped.slots.map((x) => [x.slot, x.building])).toEqual([
			[1, 'farm'],
			[0, 'quarry'],
		]);
		const razed = buildingRazed(s, 's1', 'd', 1)!;
		expect(razed.slots.map((x) => x.slot)).toEqual([0]);
		expect(razed.construction).toEqual([]);
		expect(Object.keys(razed.effects)).toEqual(['d/0']);
	});

	it('heroes: a name card, experience below the next level, a marrow pill: the browser makes the change the server makes', async () => {
		const p = player({ 'buildings.speed': 1e6 });
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		const at = T0 + 1_000;
		await p.grant(at, 'gold', 5000);
		await p.run(at, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		for (const item of ['name-card', 'field-notes', 'manual-scrap', 'marrow-pill'])
			await p.run(at, 'items.grant', { item, count: 1 }, true);
		const list = async () => ((await p.views(at, ['heroes.list']))['heroes.list'] as Omit<HeroInfo, 'bonus'>[])[0];
		const before = await list();
		const hero = before.id;
		await p.run(at, 'items.use.name-card', { hero, name: ' 赵 子龙 ' });
		expect({ ...before, ...renamedTo(' 赵 子龙 ') }).toEqual(await list());

		// Experience as the browser works it out (static heroes.growth, the server's own function), levels and all.
		const growth = await p.static<HeroGrowth>(at, 'heroes.growth');
		const grownBy = (h: Omit<HeroInfo, 'bonus'>, exp: number) => {
			const after = withExp(h, exp, growth);
			return { ...after, expToNext: expToNextOf(growth, after.level) };
		};
		const h1 = await list();
		await p.run(at, 'items.use.field-notes', { hero });
		expect(grownBy(h1, 100)).toEqual(await list());
		const h2 = await list();
		await p.run(at, 'items.use.manual-scrap', { hero });
		const grown = await list();
		expect(grown.level).toBeGreaterThan(h2.level);
		expect(grownBy(h2, 1000)).toEqual(grown);
		await p.run(at, 'heroes.allocate', { hero, points: { might: 1 } });
		const spent = await list();
		expect(spent.alloc).toEqual({ might: 1 });
		await p.run(at, 'items.use.marrow-pill', { hero });
		expect({ ...spent, ...respecced(spent) }).toEqual(await list());
		expect((await list()).freePoints).toBe(grown.freePoints);

		const o = { injured: [{ hero, healingUntil: null, cost: {}, seconds: 1 }] } as unknown as RealmsOverview;
		expect(healed(o, hero).injured).toEqual([]);
	});

	it('travel packs: fewer, the repeats follow; more, known only when the rule held them back already', () => {
		expect(repeatsAfter(3, 3, 2)).toBe(2);
		expect(repeatsAfter(2, 5, 4)).toBe(2);
		expect(repeatsAfter(2, 5, 6)).toBe(2);
		expect(repeatsAfter(3, 3, 4)).toBeUndefined();
		expect(truce(0, 24, T0)).toBe(T0 + 24 * 3600_000);
		expect(truce(T0 + 1_000, 1, T0)).toBe(T0 + 1_000 + 3600_000);
	});

	it('the levy quota in the forms held: an order adds, training takes', () => {
		const patches: FormPatches = {
			forms: [
				{ command: 'items.use.levy-a', patch: { data: { 'starter-levies.quota': { unit: 'a', quota: 5, adds: 100 } } } },
				{ command: 'items.use.levy-b', patch: { data: { 'starter-levies.quota': { unit: 'b', quota: 1, adds: 100 } } } },
				{ command: 'other' },
			],
		};
		const after = quotaChanged(
			quotaChanged(patches, 'a', (q) => q.adds),
			'b',
			() => -3,
		);
		expect(after.forms.map((f) => (f.patch?.data?.['starter-levies.quota'] as { quota: number } | undefined)?.quota)).toEqual([
			105,
			0,
			undefined,
		]);
		expect(quotaChanged(patches, 'c', () => 1)).toBe(patches);
	});

	it('a drill order picks the barracks in the browser, from the garrisons held: one training shows at once', async () => {
		const q = player({ 'buildings.speed': 1e6 });
		const d = await q.start();
		await q.construct(T0, d.id, inner(d).id, 0, 'barracks');
		const at = T0 + 1_000;
		for (const r of ['food', 'metal', 'gold', 'wood', 'stone']) await q.grant(at, r, 100_000);
		await q.run(at, 'items.grant', { item: 'drill-order-m', count: 1 }, true);
		const form = async () =>
			((await q.views(at, ['ui.forms'], { placement: 'items', settlement: d.id }))['ui.forms'] as ResolvedForm[]).find(
				(f) => f.command === 'items.use.drill-order-m',
			);
		expect(await form()).toBeUndefined(); // nothing training
		await q.run(at, 'troops.train', { settlement: d.id, unit: 'infantry-1', count: 500 });
		const f = await form();
		expect(f?.fields.find((x) => x.name === 'barracks')?.options?.map((o) => o.value)).toEqual(['barracks']);
		expect(f?.fields.find((x) => x.name === 'barracks')?.default).toBe('barracks');
	});
});

describe('claims in the browser', () => {
	it('a mail claimed: claimed and read in the inbox held', () => {
		const inbox: MailInbox = {
			messages: [{ id: 'm', at: 1, kind: 'mail.broadcast', title: { text: 'x' }, read: false, gift: 'unclaimed' }],
			more: false,
		};
		expect(claimed(inbox, 'm').messages[0]).toMatchObject({ gift: 'claimed', read: true });
		expect(claimed(inbox, 'other')).toBe(inbox);
	});

	it('rewards by kind: items and yuanbao counted on, troops into the capital, a pool or a hero made old', () => {
		const held: Record<string, unknown> = {
			'items.owned': { a: 1 },
			'shop.wallet': { balance: 10, today: {} },
			'settlements.mine': [{ id: 'cap', kind: 'capital' }],
			'troops.state': {
				selected: null,
				garrisons: [
					{ settlement: 'cap', name: { text: 'x' }, units: [{ id: 'u', count: 2 }], upkeep: { food: 2 }, upkeepBy: [], training: [] },
				],
			} satisfies TroopsState,
		};
		const stale: string[] = [];
		const get: ClientViewGet = {
			data: <D>(v: string) => held[v] as D,
			static: <S>(id: string) => (id === 'troops.units' ? ({ u: { upkeep: { food: 1 } } } as S) : undefined),
			params: {},
			meta: ((key: string) => (key === 'settlementKinds' ? [{ id: 'capital', capital: true }] : undefined)) as ClientViewGet['meta'],
			parts: (point) => partsAt(clientParts, point),
		};
		applyRewards(
			[
				{ kind: 'item', config: { item: 'a', count: 2 } },
				{ kind: 'coupons', config: { amount: 5 } },
				{ kind: 'troops', config: { unit: 'u', count: 3 } },
				{ kind: 'hero', config: { venue: 'tavern' } },
				{ kind: 'pool', config: [{ weight: 1, kind: 'item', config: { item: 'b', count: 1 } }] },
			],
			{
				patchView: (view, change) => void (held[view] = change(held[view] as never)),
				markStale: (view) => void stale.push(view),
				get,
				times: 2,
			},
		);
		expect(held['items.owned']).toEqual({ a: 5 });
		expect((held['shop.wallet'] as ShopWallet).balance).toBe(20);
		expect((held['troops.state'] as TroopsState).garrisons[0]).toMatchObject({ units: [{ id: 'u', count: 8 }], upkeep: { food: 8 } });
		// A hero comes whole with the answer ("heroes.created"): nothing made old for it; a pool's draw only the server knows.
		expect(stale).toEqual(['items.owned']);
	});

	it('puzzles: an exchange takes spares first, a claim one of each piece; the board follows the Items page cards', () => {
		const h: PuzzleHolding = {
			id: 'p',
			name: 'P',
			grid: 2,
			image: null,
			limit: 3,
			pieces: 4,
			claims: 0,
			held: [
				{ piece: 0, name: 'A1', count: 3, spares: 2, reward: null },
				{ piece: 1, name: 'A2', count: 1, spares: 0, reward: null },
				{ piece: 2, name: 'B1', count: 1, spares: 0, reward: null },
				{ piece: 3, name: 'B2', count: 2, spares: 1, reward: null },
			],
		};
		const mine: PuzzleProgress[] = [{ id: 'p', pieces: [0, 1, 2, 3], claims: 0, spares: 3 }];
		const ex = exchanged([h], 'p', 0, 2);
		expect(ex.mine(mine)).toEqual([{ id: 'p', pieces: [0, 1, 2, 3], claims: 0, spares: 1 }]);
		const ex2 = exchanged([h], 'p', 1, 1);
		expect(ex2.holdings![0].pieces).toBe(3);
		expect(ex2.mine(mine)![0].pieces).toEqual([0, 2, 3]);
		const cl = claimedPuzzle([h], 'p');
		expect(cl.mine(mine)).toEqual([{ id: 'p', pieces: [0, 3], claims: 1, spares: 1 }]);
		expect(cl.holdings![0].held.map((x) => [x.piece, x.count, x.spares])).toEqual([
			[0, 2, 1],
			[3, 1, 0],
		]);
		// Without the cards: known only when there were no spares.
		expect(claimedPuzzle(undefined, 'p').mine(mine)).toBeNull();
		expect(claimedPuzzle(undefined, 'p').mine([{ ...mine[0], spares: 0 }])).toEqual([{ id: 'p', pieces: [], claims: 1, spares: 0 }]);
		expect(albumClaimed([], 'p', T0)).toEqual([{ id: 'p', claims: 1, firstAt: T0 }]);
		expect(albumClaimed([{ id: 'p', claims: 1, firstAt: 1 }], 'p', T0)).toEqual([{ id: 'p', claims: 2, firstAt: 1 }]);
	});
});
