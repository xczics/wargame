/** Server upgrades (1.4.1): each version records its rules; time before an upgrade is settled at the rules of the time. */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import pkg from '../../package.json';
import { computeViews, engineContext, executeCommand, resolveConfig } from '../../src/kernel';
import { forgetUpgrade, historical, upgradeOf } from '../../src/runtime/versions';
import type { ResourcePool } from '../../src/shared/api';
import { db, defaultKernel, files, outer, player, T0 } from '../helpers';

describe('server upgrades', () => {
	it('records this version once, and before it what 1.4.0 had (from the history)', async () => {
		await env.DB.prepare('DELETE FROM engine_versions').run();
		forgetUpgrade();
		const values = resolveConfig(defaultKernel).values;
		const up = await upgradeOf(env.DB, files, values, T0);
		expect(up?.at).toBe(T0);
		// 1.4.0's counting house made 0.03 gold a level, linearly (1.4.1: 0.0568 x level^1.2).
		const goldMine = (up!.config['buildings.rules'] as Record<string, { produces?: Record<string, number>; producesPower?: number }>)[
			'gold-mine'
		];
		expect(goldMine).toMatchObject({ produces: { gold: 0.03 }, producesPower: 1 });
		const now = (values['buildings.rules'] as Record<string, { produces?: Record<string, number> }>)['gold-mine'].produces;
		expect(now).toEqual({ gold: 0.0568 });
		const { results } = await env.DB.prepare('SELECT version, started_at FROM engine_versions ORDER BY started_at').all();
		expect(results).toEqual([
			{ version: '1.4.0', started_at: 0 },
			{ version: pkg.version, started_at: T0 },
		]);
		// Asked again (another isolate): the same, nothing more written.
		forgetUpgrade();
		expect((await upgradeOf(env.DB, files, values, T0 + 60_000))?.at).toBe(T0);
		// Without a bucket nothing is recorded or used.
		forgetUpgrade();
		expect(await upgradeOf(env.DB, undefined, values, T0)).toBeNull();
		expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM engine_versions').first<{ n: number }>())!.n).toBe(2);
		// Rules the history does not name keep their value; an unknown version has none.
		expect(historical('1.4.0', values)!['battle.damageFactor']).toBe(values['battle.damageFactor']);
		expect(historical('0.0.1', values)).toBeNull();
	});

	it('settles a pool up to the upgrade at the old rules, then at the new ones, once', async () => {
		const p = player();
		const c = await p.start();
		await p.grant(T0, 'wood', 10_000);
		await p.grant(T0, 'stone', 10_000);
		await p.construct(T0, c.id, outer(c).id, 0, 'farm');
		const built = T0 + 3_600_000;
		const base = (await p.pool(built)).amounts.food;
		const rate = (await p.pool(built)).rates.food;
		expect(rate).toBeGreaterThan(0);
		// Commit at `built` so the stored food is as of then; the upgrade comes an hour later.
		await p.grant(built, 'food', 0);
		const at = built + 3_600_000;
		const now = at + 3_600_000;
		// Before the upgrade, output was twice as high (a production multiplier of 20 instead of the tests' 10).
		const old = resolveConfig(defaultKernel, { ...p.overrides, 'buildings.productionMultiplier': 20 }).values;
		const ctx = { ...engineContext(defaultKernel, p.id, now, p.overrides), files, upgrade: { at, config: old } };
		const pool = (await computeViews(defaultKernel, db, ctx, ['resources.pool'], {})).views['resources.pool'] as ResourcePool;
		const cap = pool.capacity;
		expect(pool.amounts.food).toBeCloseTo(Math.min(cap, base + rate * 2 * 3600 + rate * 3600), 3);
		// Once written (any command), the time before the upgrade is not counted again.
		await executeCommand(defaultKernel, db, { ...ctx, privileged: true }, 'resources.grant', { resource: 'food', amount: 0 });
		const later = { ...ctx, now: now + 1_000 };
		const again = (await computeViews(defaultKernel, db, later, ['resources.pool'], {})).views['resources.pool'] as ResourcePool;
		expect(again.amounts.food).toBeCloseTo(Math.min(cap, pool.amounts.food + rate), 3);
	});
});
