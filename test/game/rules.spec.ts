/** Engine-wide behaviour: concurrency, GM-tunable rules; prestige. */
import { describe, expect, it } from 'vitest';
import { engineContext } from '../../src/kernel';
import type { PrestigeStatus } from '../../src/shared/api';
import { db, T0, defaultKernel, player, inner, outer } from '../helpers';

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
		const p = player({ 'buildings.productionMultiplier': 30 }); // three times the tests' usual 10: a farm level 3 food a second
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
			isFresh: () => false,
			peek: () => undefined,
			fresh: () => {},
		};
		return defaultKernel.services.get('stats').get(api as never, 'settlements.limit.city', `player:${p.id}`);
	};

	it('grows with what is spent (1 per 1,000), and a cancelled construction takes its share back', async () => {
		const p = player({ 'buildings.cancelRefund': 1 });
		const c = await p.start();
		expect(await status(p)).toMatchObject({
			value: 0,
			rank: { index: 0, name: 'starter-prestige.Commoner' },
			next: { name: 'starter-prestige.Village Head', threshold: 50 },
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
		expect(await status(p)).toMatchObject({
			rank: { index: 5, name: 'starter-prestige.County Magistrate' },
			next: { name: 'starter-prestige.Commandery Assistant' },
		});
		expect(await cityLimit(p)).toBe(1);
		// Bandits take it down: the value falls, the rank and its city do not.
		await p.run(T0, 'prestige.grant', { amount: -2000 }, true);
		expect(await status(p)).toMatchObject({ value: 795, best: 2795, rank: { index: 5 } });
		expect(await cityLimit(p)).toBe(1);
		await p.run(T0, 'prestige.grant', { amount: 1e6 }, true);
		expect(await status(p)).toMatchObject({ rank: { index: 29, name: 'starter-prestige.Chancellor of State' } });
		expect((await status(p)).next).toBeUndefined();
		expect(await cityLimit(p)).toBe(5);
		await expect(p.run(T0, 'prestige.grant', { amount: 5 })).rejects.toThrow(); // GM only
		// The badge next to the user name (generic widget ui.badge): rank, prestige, what the next rank needs.
		const badge = (await p.views(T0, ['prestige.badge']))['prestige.badge'];
		expect(badge).toEqual({
			label: { text: 'starter-prestige.Chancellor of State' },
			value: { text: 'prestige.Prestige {n}', vars: { n: '1,000,795' } },
			title: { text: 'prestige.The highest rank' },
		});
	});
});
