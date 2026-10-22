/** The bench routes (src/plugins/bench): off by default, a player's own, and never changing a row. */
import { createExecutionContext, SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import worker from '../src/index';

const BASE = 'https://wargame.test';

async function call(
	method: string,
	path: string,
	{ cookie = '', body, bench = false }: { cookie?: string; body?: unknown; bench?: boolean } = {},
) {
	const request = new Request(`${BASE}${path}`, {
		method,
		headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const res = bench
		? await worker.fetch(request as never, { ...env, BENCH: '1' } as never, createExecutionContext())
		: await SELF.fetch(request);
	return { status: res.status, body: (await res.json()) as any, cookie: res.headers.get('set-cookie')?.split(';')[0] ?? '' };
}

/** A player with a capital (it starts with buildings to upgrade) and plenty to pay with. */
async function benchPlayer() {
	let gm = (await call('POST', '/api/auth/login', { body: { username: 'gm', password: 'gm-changed-password' } })).cookie;
	if (!gm) {
		const first = await call('POST', '/api/auth/login', { body: { username: 'gm', password: 'gm-test-password' } });
		gm = first.cookie;
		if (first.body.user.mustChangePassword)
			await call('POST', '/api/auth/password', {
				cookie: gm,
				body: { oldPassword: 'gm-test-password', newPassword: 'gm-changed-password' },
			});
	}
	const invite = await call('POST', '/api/invites', { cookie: gm, body: {} });
	const reg = await call('POST', '/api/auth/register', {
		body: { username: `bench-${crypto.randomUUID().slice(0, 8)}`, password: 'hunter2hunter2', inviteCode: invite.body.code },
	});
	expect(reg.status).toBe(201);
	const id = reg.body.user.id as string;
	const capital = await env.DB.prepare('SELECT id FROM settlements_settlements WHERE owner_id = ?').bind(id).first<{ id: string }>();
	for (const resource of ['stone', 'wood', 'food', 'metal', 'gold'])
		expect(
			(
				await call('POST', `/api/gm/players/${id}/command`, {
					cookie: gm,
					body: { type: 'resources.grant', payload: { resource, amount: 1e6 } },
				})
			).status,
		).toBe(200);
	return { id, cookie: reg.cookie, capital: capital!.id };
}

/** Everything a construct would change, for "nothing changed". */
const snapshot = async (id: string, capital: string) =>
	JSON.stringify(
		await env.DB.batch([
			env.DB.prepare('SELECT * FROM buildings_construction WHERE settlement_id = ?').bind(capital),
			env.DB.prepare('SELECT * FROM buildings_slots WHERE settlement_id = ? ORDER BY district_id, slot').bind(capital),
			env.DB.prepare('SELECT * FROM resources_balances WHERE holder = ? ORDER BY resource').bind(`settlement:${capital}`),
			env.DB.prepare('SELECT * FROM timeline_events WHERE entity = ? ORDER BY id').bind(`settlement:${capital}`),
			env.DB.prepare('SELECT * FROM engine_locks WHERE entity >= ? AND entity < ? ORDER BY entity').bind(`player:${id}`, `player:${id}~`),
			env.DB.prepare('SELECT key, value FROM engine_derived WHERE owner = ? ORDER BY key').bind(id),
		]).then((rs) => rs.map((r) => r.results)),
	);

describe('bench routes', () => {
	it('are not there unless BENCH is "1", and need a player', async () => {
		const { cookie } = await benchPlayer();
		expect((await call('GET', '/api/_bench/noop', { cookie })).status).toBe(404);
		expect((await call('POST', '/api/_bench/real/buildings.construct', { cookie, body: {} })).status).toBe(404);
		expect((await call('GET', '/api/_bench/noop', { bench: true })).status).toBe(401);
		expect((await call('GET', '/api/_bench/sync?views=resources.pool', { bench: true })).status).toBe(401);
		expect((await call('GET', '/api/_bench/noop', { cookie, bench: true })).status).toBe(200);
	});

	it('measure each phase without changing a row', async () => {
		const { id, cookie, capital } = await benchPlayer();
		const get = async (path: string) => {
			const r = await call('GET', path, { cookie, bench: true });
			expect(r.status, path).toBe(200);
			return r.body;
		};
		expect((await get('/api/_bench/timers?n=1000')).n).toBe(1000);
		for (const mode of ['seq', 'batch', 'pack']) expect((await get(`/api/_bench/d1?n=5&mode=${mode}`)).mode).toBe(mode);
		const assembled = await get('/api/_bench/assemble?rules=1');
		expect(assembled.plugins).toBeGreaterThan(40);
		expect(assembled.rules).toBeGreaterThan(50);
		await get('/api/_bench/upgrade');

		// The same views as /api/state for the same query.
		const query = `views=resources.pool,settlements.mine&settlement=${capital}`;
		const sync = await get(`/api/_bench/sync?_bench=city&_n=1&${query}`);
		const state = (await call('GET', `/api/state?${query}`, { cookie })).body;
		expect(Object.keys(sync.views).sort()).toEqual(Object.keys(state.views).sort());
		expect(sync.views['settlements.mine']).toEqual(state.views['settlements.mine']);

		const { target } = await get('/api/_bench/target');
		expect(target).toMatchObject({ settlement: capital, level: 1 });
		const payload = { settlement: target.settlement, district: target.district, slot: target.slot };
		const before = await snapshot(id, capital);

		const raw = await call('POST', '/api/_bench/raw/buildings.construct', { cookie, bench: true, body: payload });
		expect(raw.body.result).toMatchObject({ ok: true, building: target.building, toLevel: 2 });
		const real = await call('POST', `/api/_bench/real/buildings.construct?views=resources.pool&settlement=${capital}`, {
			cookie,
			bench: true,
			body: payload,
		});
		expect(real.body).toMatchObject({ ok: true, error: null });
		expect(real.body.replaced.statements).toBeGreaterThan(3);
		expect(real.body.state.views['resources.pool']).toBeTruthy();
		// Again: the same work, since nothing was committed (a real second construct would be refused: busy).
		expect((await call('POST', '/api/_bench/real/buildings.construct', { cookie, bench: true, body: payload })).body.ok).toBe(true);
		expect(await snapshot(id, capital)).toBe(before);

		// A refused command is reported, not thrown; privileged ones stay unknown to players.
		const refused = await call('POST', '/api/_bench/real/buildings.construct', { cookie, bench: true, body: { ...payload, slot: 999 } });
		expect(refused.body.ok).toBe(false);
		const gmOnly = await call('POST', '/api/_bench/real/resources.grant', { cookie, bench: true, body: { resource: 'gold', amount: 1 } });
		expect(gmOnly.body.error.code).toBe('unknown_command');
		expect(await snapshot(id, capital)).toBe(before);
	});
});
