/** The usage guard (src/plugins/usage-guard): pauses the game near R2's free tier, reopens when it is clear again. */
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createKernel, engineContext, executeCommand } from '../src/kernel';
import { plugins } from '../src/plugins';

const vars = { CF_API_TOKEN: 'test-token', CF_ACCOUNT_ID: 'acc', FILES_BUCKET: 'wargame-files', FILES_BASE_URL: 'https://src.example.com' };
const guarded = { ...env, ...vars } as unknown as Env;
const T0 = Date.UTC(2031, 2, 15);

/** Cloudflare's answers: R2 operations and storage for the analytics, and the custom domain switch (recorded). */
function cloudflare(ops: Record<string, number>, bytes = 1e6, fail = false) {
	const domain: boolean[] = [];
	const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		if (url.endsWith('/graphql')) {
			if (fail) return new Response('nope', { status: 500 });
			return Response.json({
				data: {
					viewer: {
						accounts: [
							{
								ops: Object.entries(ops).map(([actionType, requests]) => ({ sum: { requests }, dimensions: { actionType } })),
								storage: [{ max: { payloadSize: bytes, metadataSize: 0 }, dimensions: { bucketName: 'wargame-files', datetime: '' } }],
							},
						],
					},
				},
			});
		}
		if (url.includes('/r2/buckets/wargame-files/domains/custom/src.example.com')) {
			domain.push(JSON.parse(String(init?.body)).enabled);
			return Response.json({ success: true });
		}
		throw new Error(`unexpected fetch ${url}`);
	});
	return { spy, domain };
}

describe('usage guard', () => {
	beforeEach(async () => {
		await env.DB.prepare('DELETE FROM usage_guard_state').run();
	});
	afterEach(() => vi.restoreAllMocks());

	const run = (kernel: ReturnType<typeof createKernel>, now: number, e: Env = guarded) =>
		kernel.tasks.get('usage-guard.check')!.run({ kernel, env: e, now });
	// Not the only gate (the bench counts requests with one).
	const guardOf = (kernel: ReturnType<typeof createKernel>) => kernel.gates.find((g) => g.id === 'usage-guard.pause')!;
	const gate = (kernel: ReturnType<typeof createKernel>, path: string) =>
		guardOf(kernel).check({ kernel, env: guarded, request: new Request(`https://x${path}`), url: new URL(`https://x${path}`) });

	it('pauses past half of a free amount: players get 503, the GM and logging in do not; the public domain goes off', async () => {
		const kernel = createKernel(plugins);
		expect(kernel.tasks.get('usage-guard.check')!.always).toBe(true);
		const cf = cloudflare({ GetObject: 4_000_000, HeadObject: 1_100_000, PutObject: 10, DeleteObject: 9e9 }); // B: 51%
		await run(kernel, T0);
		const held = await gate(kernel, '/api/state');
		expect(held!.status).toBe(503);
		expect(await held!.json()).toMatchObject({ error: { code: 'paused' } });
		expect(await gate(kernel, '/api/gm/config')).toBeNull();
		expect(await gate(kernel, '/api/auth/me')).toBeNull();
		expect(await gate(kernel, '/assets/x.js')).toBeNull();
		expect(cf.domain).toEqual([false]);
		expect(await guardOf(kernel).closed!({ kernel, env: guarded, now: T0 })).toBe(true);
		// Deletes are free: 9e9 of them did not count.
		const row = await env.DB.prepare('SELECT usage FROM usage_guard_state').first<{ usage: string }>();
		expect(JSON.parse(row!.usage)).toMatchObject({ classA: 10, classB: 5_100_000 });
	});

	it('asks only every few minutes, keeps its state when Cloudflare does not answer, and reopens once clear', async () => {
		const kernel = createKernel(plugins);
		let cf = cloudflare({ PutObject: 600_000 }); // A: 60%
		await run(kernel, T0);
		expect(await gate(kernel, '/api/state')).not.toBeNull();
		await run(kernel, T0 + 5 * 60_000); // within the 10 minutes: not asked
		expect(cf.spy.mock.calls.filter(([u]) => String(u).endsWith('/graphql'))).toHaveLength(1);
		vi.restoreAllMocks();
		cf = cloudflare({}, 0, true);
		await run(kernel, T0 + 11 * 60_000); // no answer: still paused
		expect(await gate(kernel, '/api/state')).not.toBeNull();
		vi.restoreAllMocks();
		// The month turned: nearly nothing used: open again, the domain back on.
		cf = cloudflare({ GetObject: 1000 }, 5e8);
		const next = Date.UTC(2031, 3, 1, 0, 30);
		await run(kernel, next);
		expect(await guardOf(kernel).closed!({ kernel, env: guarded, now: next + 61_000 })).toBe(false);
		expect(await gate(kernel, '/api/state')).toBeNull();
		expect(cf.domain).toEqual([true]);
	});

	it('does nothing without a token (local runs, Docker), and the GM can lift a pause', async () => {
		const kernel = createKernel(plugins);
		const cf = cloudflare({ GetObject: 9_000_000 });
		await run(kernel, T0, env as Env);
		expect(cf.spy).not.toHaveBeenCalled();
		expect(await gate(kernel, '/api/state')).toBeNull();
		await run(kernel, T0);
		expect(await env.DB.prepare('SELECT tripped FROM usage_guard_state').first('tripped')).toBe(1);
		await executeCommand(kernel, env.DB, engineContext(kernel, crypto.randomUUID(), T0, {}, true), 'usage-guard.resume', {});
		expect(await env.DB.prepare('SELECT tripped, checked_at FROM usage_guard_state').first()).toEqual({ tripped: 0, checked_at: 0 });
		await expect(
			executeCommand(kernel, env.DB, engineContext(kernel, crypto.randomUUID(), T0, {}, true), 'usage-guard.resume', {}),
		).rejects.toThrow(/not paused/);
	});
});
