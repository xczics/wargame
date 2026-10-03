/** Items and the coupon shop. */
import { describe, expect, it } from 'vitest';
import { computeViews, engineContext } from '../../src/kernel';
import type {
	GarrisonInfo,
	HeroCandidates,
	HeroInfo,
	ItemStack,
	ResearchTree,
	ResolvedForm,
	SettlementSummary,
	ShopStore,
} from '../../src/shared/api';
import type { CardsData } from '../../src/shared/ui';
import { db, T0, defaultKernel, en, player, inner, inbox, outer } from '../helpers';

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
		await expect(p.run(T0, 'items.use.land-grant', { settlement: c.id, district: outer(c).id })).rejects.toMatchObject({
			text: { text: 'items.You have no {0}', vars: { 0: { text: 'starter-items.Land grant' } } },
		});
	});

	it("expansion permits raise the outer-city quota; breakthrough stones raise one building's cap", async () => {
		const p = player({ 'settlements.outerTechLimit': 1, 'buildings.rules': { farm: { cap: 1 } }, ...SURE });
		const c = await p.start();
		expect((await p.detail(T0)).nextOuter!.blocked).toEqual({ text: 'settlements.Research more to build more outer cities' });
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
		expect((await inbox(p, T0 + 20_000)).messages.map((m) => m.title.text)).toContain('starter-items.{item} worked: {what}');
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
			return f && en(f.description);
		};
		expect(await limit()).toBeUndefined(); // no charter yet
		await p.run(T0, 'items.grant', { item: 'city-charter', count: 1 }, true);
		expect(await limit()).toMatch(/^Limit \(City\): 0\/4 · pity 0\/2 \(you have 1\)$/); // 50%: sure by the 2nd try
		for (const tech of ['frontier-towns', 'circuits', 'provinces']) await p.run(T0, 'research.setLevel', { tech, level: 1 }, true);
		expect(await limit()).toMatch(/^Limit \(City\): 3\/4 · pity 0\/2/); // n counts charters only, not techs
		// A sure charter adds one; at the hard limit the next is refused and kept.
		const sure = player({ 'player-settlements.limits': { city: 3 }, 'player-settlements.limitMax': { city: 4 }, ...SURE });
		await sure.start();
		await sure.run(T0, 'items.grant', { item: 'city-charter', count: 2 }, true);
		await sure.run(T0, 'items.use.city-charter', null);
		await expect(sure.run(T0, 'items.use.city-charter', null)).rejects.toMatchObject({
			text: { text: 'starter-items.Limit reached: {0}', vars: { 0: { text: 'player-settlements.City' } } },
		});
		expect((await inbox(sure, T0)).messages.map((m) => m.title.text)).toContain('starter-items.{item} worked: {what}');
	});

	it('fortresses start at none too: tech milestones, a late tech a level, and charters with no limit', async () => {
		const p = player({ 'player-settlements.limits': { 'fortress-resource': 0 }, ...SURE });
		const c = await p.start();
		const limit = async () =>
			en(
				((await p.views(T0, ['ui.forms'], { placement: 'items', settlement: c.id }))['ui.forms'] as ResolvedForm[]).find(
					(x) => x.command === 'items.use.resource-fortress-charter',
				)?.description,
			);
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
		expect(en(forms.find((x) => x.command === 'items.use.military-fortress-charter')?.description)).toMatch(
			/^Limit \(Military fortress\): 0 · /,
		);
		expect(await limit()).toBe(''); // used up, but it worked:
		expect((await inbox(p, T0)).messages.map((m) => m.title.text)).toContain('starter-items.{item} worked: {what}');
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
					isFresh: () => false,
					fresh: () => {},
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
			en(
				((await p.views(T0, ['ui.forms'], { placement: 'items', settlement: c.id }))['ui.forms'] as ResolvedForm[])
					.find((f) => f.command === 'items.use.land-grant')!
					.fields.find((f) => f.name === 'district')!.options![0].label,
			);
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
		expect(
			en(asGm.find((f) => f.command === 'items.use.land-grant')!.fields.find((f) => f.name === 'district')!.options![0].label),
		).toMatch(/0% · pity 0\/3$/);
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
		expect(en(later.fields.find((f) => f.name === 'district')!.options![0].label)).toMatch(/pity 0\/3$/);
		const titles = (await inbox(p, T0)).messages.map((m) => m.title.text);
		expect(titles.filter((t) => t.startsWith('starter-items.{item} failed'))).toHaveLength(3);
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
		expect(d.summary).toEqual([{ text: 'shop.💰 {n} yuanbao', vars: { n: '60' } }]);
		expect(d.groups!.map((g) => g.id)).toContain('building');
		const card = (id: string) => d.cards.find((c) => c.id === id)!;
		expect(card('expansion-permit')).toMatchObject({
			group: 'building',
			lines: [{ tone: 'warn' }],
			actions: [{ blocked: { text: 'shop.Not enough coupons' } }],
		});
		expect(card('city-charter').actions![0]).toEqual({
			command: 'shop.buy',
			payload: { offer: 'city-charter' },
			label: { text: 'shop.Buy' },
			pending: { text: 'shop.Buying {0}…', vars: { 0: { text: 'starter-items.City charter' } } },
			notice: { text: 'shop.Bought {0} × {1}: it is in your inventory.', vars: { 0: { text: 'starter-items.City charter' }, 1: 1 } },
		});
		await p.run(T0, 'shop.buy', { offer: 'city-charter' });
		d = await cards();
		expect(card('city-charter').lines![1]).toEqual({ text: { text: 'shop.today {n} / {limit}', vars: { n: 1, limit: 1 } }, tone: 'muted' });
		expect(card('city-charter').actions![0].blocked).toEqual({ text: 'shop.Daily limit reached' });
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
		await expect(p.run(T0, 'shop.buy', { offer: 'harvest-rite', quantity: 2 })).rejects.toMatchObject({
			text: { text: 'shop.Daily limit reached ({0} / {1})', vars: { 0: 2, 1: 3 } },
		});
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
		for (const r of ['wood', 'stone', 'metal', 'gold']) await p.grant(T0, r, 5000);
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

describe('items for names, recruiting and moving buildings', () => {
	const rich = {
		'buildings.speed': 1e6,
		'resources.initial': { food: 1e6, wood: 1e6, stone: 1e6, metal: 1e6, gold: 1e6 },
		'resources.baseCapacity': 1e7,
	};
	const give = (p: ReturnType<typeof player>, item: string, count = 1) => p.run(T0, 'items.grant', { item, count }, true);
	const candidates = async (p: ReturnType<typeof player>, now: number, venue: string) =>
		((await p.views(now, ['heroes.candidates']))['heroes.candidates'] as HeroCandidates[]).find((v) => v.venue === venue)!;

	it('names a hero as typed; a settlement is named once for free, again with a decree', async () => {
		const p = player(rich);
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		const at = T0 + 2_000;
		await p.run(at, 'heroes.recruit', { settlement: c.id, venue: (await candidates(p, at, 'tavern')).venue, slot: 0 });
		const [hero] = (await p.views(at, ['heroes.list']))['heroes.list'] as HeroInfo[];
		await give(p, 'name-card');
		await p.run(at, 'items.use.name-card', { hero: hero.id, name: '赵 子龙' });
		const renamed = ((await p.views(at, ['heroes.list']))['heroes.list'] as HeroInfo[])[0];
		// One name part the client shows as typed.
		expect([renamed.surname, renamed.given]).toEqual([`n:${encodeURIComponent('赵 子龙')}`, '']);
		await expect(p.run(at, 'items.use.name-card', { hero: hero.id, name: 'x' })).rejects.toThrow(); // used up

		await p.run(at, 'settlements.rename', { settlement: c.id, name: 'Chang an' });
		await expect(p.run(at, 'settlements.rename', { settlement: c.id, name: 'Luoyang' })).rejects.toMatchObject({
			text: { text: 'starter-items.Renaming again takes a {0}' },
		});
		await give(p, 'renaming-decree');
		await p.run(at, 'items.use.renaming-decree', { settlement: c.id, name: 'Luoyang' });
		expect(((await p.views(at, ['settlements.mine']))['settlements.mine'] as SettlementSummary[])[0].name).toBe('Luoyang');
	});

	it('invites a music-house candidate (sure by the fourth try) and gives the tavern new faces', async () => {
		const p = player(rich);
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'music-house');
		await p.construct(T0 + 2_000, c.id, inner(c).id, 1, 'tavern');
		const at = T0 + 4_000;
		const music = (await candidates(p, at, 'music-house')).venue;
		const gifts = async () => (await candidates(p, at, music)).candidates.filter((x) => x?.gift).length;
		await give(p, 'music-house-invitation', 4);
		for (let i = 0; i < 4 && !(await gifts()); i++) await p.run(at, 'items.use.music-house-invitation', { settlement: c.id });
		expect(await gifts()).toBe(1);

		const faces = async () => JSON.stringify((await candidates(p, at, 'tavern')).candidates.map((x) => x && [x.surname, x.given, x.attrs]));
		const before = await faces();
		await give(p, 'tavern-banner');
		await p.run(at, 'items.use.tavern-banner', { settlement: c.id });
		expect(await faces()).not.toBe(before);
		expect((await candidates(p, at, 'tavern')).refreshesAt).toBeGreaterThan(at); // the timer goes on
	});

	it('moves a building to an empty slot, or swaps two, within one district', async () => {
		const p = player(rich);
		const c = await p.start();
		const o = outer(c).id;
		await p.construct(T0, c.id, o, 0, 'farm');
		await p.construct(T0 + 2_000, c.id, o, 1, 'lumber-mill');
		const at = T0 + 4_000;
		const slots = async () =>
			Object.fromEntries(outer(await p.detail(at)).slots.flatMap((s) => (s.current ? [[s.slot, s.current.building]] : [])));
		await give(p, 'relocation-order');
		await give(p, 'exchange-order');
		await expect(p.run(at, 'items.use.relocation-order', { settlement: c.id, district: o, from: '0', to: '1' })).rejects.toThrow(/taken/);
		await p.run(at, 'items.use.relocation-order', { settlement: c.id, district: o, from: '0', to: '4' });
		expect(await slots()).toEqual({ 1: 'lumber-mill', 4: 'farm' });
		await p.run(at, 'items.use.exchange-order', { settlement: c.id, district: o, from: '1', to: '4' });
		expect(await slots()).toEqual({ 1: 'farm', 4: 'lumber-mill' });
	});
});
