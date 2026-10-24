/** End-to-end through the Worker, D1 (accounts/invites/GM) and the player Durable Object. */
import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { RowsData } from '../src/shared/ui';
import type { BuildingsState, PersonalizationGmData, PersonalizationSite } from '../src/shared/api';
import { sniffImage, unsafeSvg } from '../src/runtime/files';
import { announcementBanner } from '../web/plugins/mail/announcement';
import indexHtml from '../index.html?raw';

/** The site's static files (Workers Assets: never the Worker), for "no icon is a 404". */
const publicRaw = import.meta.glob<string>('../public/**/*', { query: '?raw', import: 'default', eager: true });
const publicFiles = Object.keys(publicRaw).map((f) => f.replace(/^\.\.\/public/, ''));
import { createKernel, matchRoute, packReads } from '../src/kernel';
import { getKernel } from '../src/runtime/kernel-instance';
import { resolveForms } from '../src/shared/forms';
import { d1Calls, formsInput } from './helpers';
import { plugins } from '../src/plugins';
import { describe, expect, it } from 'vitest';

const BASE = 'https://wargame.test';

/** A tiny cookie-jar client. */
function client() {
	let cookie = '';
	const call = async (method: string, path: string, body?: unknown) => {
		const res = await SELF.fetch(`${BASE}${path}`, {
			method,
			headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		const set = res.headers.get('set-cookie');
		if (set) cookie = set.split(';')[0];
		return { status: res.status, body: (await res.json()) as any };
	};
	return {
		get: (path: string) => call('GET', path),
		post: (path: string, body: unknown = {}) => call('POST', path, body),
		put: (path: string, body: unknown) => call('PUT', path, body),
		del: (path: string) => call('DELETE', path),
		/** The response itself (not JSON), with the session cookie. */
		raw: (path: string) => SELF.fetch(`${BASE}${path}`, { headers: { cookie } }),
		/** The session cookie (to make a request by hand). */
		cookie: () => cookie,
		/** POST a raw body (e.g. a picture) with the session cookie. */
		postRaw: async (path: string, body: Uint8Array) => {
			const res = await SELF.fetch(`${BASE}${path}`, { method: 'POST', body, headers: { cookie } });
			return { status: res.status, body: (await res.json()) as any };
		},
	};
}

/** The GM's password after its first login (GM_PASSWORD in vitest.config.mts is only the initial one). */
const GM_PASSWORD = 'gm-changed-password';

async function loginGM() {
	const gm = client();
	if ((await gm.post('/api/auth/login', { username: 'gm', password: GM_PASSWORD })).status === 200) return gm;
	const first = await gm.post('/api/auth/login', { username: 'gm', password: 'gm-test-password' });
	expect(first.status).toBe(200);
	if (first.body.user.mustChangePassword)
		expect((await gm.post('/api/auth/password', { oldPassword: 'gm-test-password', newPassword: GM_PASSWORD })).status).toBe(200);
	return gm;
}

async function newPlayer(gm: Awaited<ReturnType<typeof loginGM>>, username: string) {
	const invite = await gm.post('/api/invites', {});
	const p = client();
	const reg = await p.post('/api/auth/register', { username, password: 'hunter2hunter2', inviteCode: invite.body.code });
	expect(reg.status).toBe(201);
	return { player: p, id: reg.body.user.id as string };
}

/**
 * The stamps as the browser holds them (web/core/game.ts `setState`): an answer's own parts under its `stampKey`, a
 * left-out view's (empty) the one held.
 */
const keyedStamps = (body: { stamps?: Record<string, string>; stampKey?: string }, held: Record<string, string> = {}) =>
	Object.fromEntries(
		Object.entries(body.stamps ?? {}).map(([v, own]) => [
			v,
			`${body.stampKey}~${own || (held[v] ?? '').slice((held[v] ?? '').indexOf('~') + 1)}`,
		]),
	);

describe('meta', () => {
	it('is public and lists plugins and content', async () => {
		const { body } = await client().get('/api/meta');
		expect(body.plugins.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(['accounts', 'invites', 'gm']));
		expect(body.resources.map((r: { id: string }) => r.id)).toEqual(['stone', 'wood', 'food', 'metal', 'gold']);
		// Where the client puts the research controls and each unit's training form.
		expect(body.researchLabs).toEqual(['institute']);
		expect(body.units.find((u: { id: string }) => u.id === 'archer-1').trainedAt).toBe('archer-camp');
		expect(body.settlementKinds.map((k: { id: string }) => k.id)).toEqual([
			'capital',
			'city',
			'fortress-resource',
			'fortress-military',
			'npc-fortress',
			'npc-outpost',
		]);
		expect(body.settlementKinds.filter((k: { npc: boolean }) => k.npc)).toHaveLength(2);
		expect(body.map).toEqual({ min: -511, max: 512 });
		// Every server plugin ships its own words; the client needs no change for new content.
		expect(body.i18n['zh-CN']).toMatchObject({ 'starter-content.Farm': '农田', 'buildings.rule:buildings.speed': expect.any(String) });
		// And says where its screens go.
		expect(body.ui.pages.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(['city', 'research', 'map']));
	});

	it('serves the map file to players, kept by the browser for good (its name is its content)', async () => {
		const gm = await loginGM();
		await gm.post('/api/gm/players/' + (await gm.get('/api/auth/me')).body.user.id + '/command', {
			type: 'terrain.paint',
			payload: { x: 0, y: 0, width: 1, height: 1, terrain: 'forest' },
		});
		const { file } = (await env.DB.prepare('SELECT file FROM terrain_version WHERE id = 1').first<{ file: string }>())!;
		expect((await client().raw(`/api/files/terrain/${file}.txt`)).status).toBe(401);
		const res = await gm.raw(`/api/files/terrain/${file}.txt`);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toContain('immutable');
		expect((await res.text()).length).toBe(1024 * 1024);
		expect((await gm.raw('/api/files/terrain/nope.txt')).status).toBe(404);
	});

	it('serves the meta by version for browsers to keep; syncs say the current version', async () => {
		const first = await SELF.fetch(`${BASE}/api/meta`);
		const version = first.headers.get('x-meta-version')!;
		expect(version).toMatch(/^[0-9a-f]{24}$/);
		const body = await first.text();
		const kept = await SELF.fetch(`${BASE}/api/meta/${version}`);
		expect(kept.headers.get('cache-control')).toContain('immutable');
		expect(await kept.text()).toBe(body);
		// An old version (a deploy since): the current meta, not kept under the old address.
		const old = await SELF.fetch(`${BASE}/api/meta/0123`);
		expect(old.headers.get('cache-control')).toBe('no-store');
		expect(old.headers.get('x-meta-version')).toBe(version);
		const gm = await loginGM();
		expect((await gm.get('/api/state?views=settlements.mine')).body.metaVersion).toBe(version);
	});

	it('bakes static views into the file bucket and serves them from there, kept for good', async () => {
		const gm = await loginGM();
		const state = (await gm.get('/api/state?views=settlements.mine')).body;
		expect(state.filesBase).toBeUndefined(); // no public bucket URL here: through the Worker
		const [id, version] = Object.entries(state.statics as Record<string, string>)[0];
		const stored = await env.FILES.get(`static/${id}/${version}.json`);
		expect(stored?.httpMetadata?.cacheControl).toContain('immutable');
		const res = await gm.raw(`/api/static/${id}/${version}`);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe(await stored!.text());
		expect((await env.FILES.get('static/manifest.json'))?.httpMetadata?.cacheControl).toBe('no-cache');
	});

	it('returns JSON 404 for unknown API routes', async () => {
		expect((await client().get('/api/does-not-exist')).status).toBe(404);
	});
});

describe('accounts & invites', () => {
	it('refuses logins after too many failures (by name and address, by address), before checking the password', async () => {
		const gm = await loginGM();
		const name = `guard${crypto.randomUUID().slice(0, 8)}`;
		await newPlayer(gm, name);
		const login = async (ip: string, password: string, username = name) => {
			const res = await SELF.fetch(`${BASE}/api/auth/login`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
				body: JSON.stringify({ username, password }),
			});
			return { status: res.status, body: (await res.json()) as any };
		};
		const ip = `10.0.${Math.floor(Math.random() * 250)}.1`;
		// A login that works clears the count for that name and address.
		for (let i = 0; i < 4; i++) expect((await login(ip, 'wrong-password')).status).toBe(401);
		expect((await login(ip, 'hunter2hunter2')).status).toBe(200);
		// Five wrong in a row: refused, even with the right password (nothing is checked while locked).
		for (let i = 0; i < 5; i++) expect((await login(ip, 'wrong-password')).status).toBe(401);
		const locked = await login(ip, 'hunter2hunter2');
		expect(locked.status).toBe(429);
		expect(locked.body.error.code).toBe('too_many_attempts');
		// The same name from another address still works (its own count is under the name's 20).
		expect((await login(`${ip}0`, 'hunter2hunter2')).status).toBe(200);
		// One address trying many names (unknown ones count alike): 30, then refused for every name.
		const other = `10.1.${Math.floor(Math.random() * 250)}.2`;
		for (let i = 0; i < 30; i++) expect((await login(other, 'x-password', `nobody${i}x${other}`)).status).toBe(401);
		expect((await login(other, 'hunter2hunter2')).status).toBe(429);
	});

	it('requires login to play', async () => {
		expect((await client().get('/api/state')).status).toBe(401);
	});

	it('lets the GM play as a player: the browser switches to that player, without GM rights, and it is audited', async () => {
		const gm = await loginGM();
		const { player } = await newPlayer(gm, 'playas');
		const frank = (await player.get('/api/auth/me')).body.user;
		expect((await client().post(`/api/gm/players/${frank.id}/play`)).status).toBe(401);
		expect((await player.post(`/api/gm/players/${frank.id}/play`)).status).toBe(403);
		expect((await gm.post('/api/gm/players/nobody/play')).status).toBe(404);
		const res = await gm.post(`/api/gm/players/${frank.id}/play`);
		expect(res.status).toBe(200);
		expect((await gm.get('/api/auth/me')).body.user).toMatchObject({ id: frank.id, username: 'playas', gm: false });
		expect((await gm.get('/api/gm/config')).status).toBe(403); // the GM session is over
		expect((await gm.get('/api/state')).status).toBe(200);
		const again = await loginGM();
		const audit = (await again.get('/api/gm/audit')).body as { action: string; detail: unknown }[];
		expect(JSON.stringify(audit)).toContain('player.play');
	});

	it('sweeps expired sessions a batch a minute and keeps live ones', async () => {
		const gm = await loginGM();
		const { player, id } = await newPlayer(gm, 'sweepme');
		const now = Math.ceil(Date.now() / 3_600_000) * 3_600_000; // the hourly run
		const insert = env.DB.prepare('INSERT INTO accounts_sessions (token_hash, user_id, gm, created_at, expires_at) VALUES (?, ?, 0, 0, ?)');
		await env.DB.batch(Array.from({ length: 250 }, () => insert.bind(`expired-${crypto.randomUUID()}`, id, now - 1)));
		const expired = async () =>
			(await env.DB.prepare("SELECT COUNT(*) AS n FROM accounts_sessions WHERE user_id = ? AND token_hash LIKE 'expired-%'")
				.bind(id)
				.first<{ n: number }>())!.n;
		const kernel = createKernel(plugins);
		const sweep = () => kernel.tasks.get('accounts.sessions')!.run({ kernel, env, now });
		await sweep();
		// Other tests' leftovers share the table, so only an upper bound for this player after one batch.
		expect(await expired()).toBeLessThan(250);
		for (let i = 0; i < 20 && (await expired()) > 0; i++) await sweep();
		expect(await expired()).toBe(0);
		expect((await player.get('/api/auth/me')).body.user).toMatchObject({ id }); // the live session survives
	});

	it('tops up settlement slots only when the fixed sizes change, not by scanning every district each hour', async () => {
		// Count the statements a run prepares (the scan of players' settlements and districts is the costly one).
		const counting = () => {
			const seen: string[] = [];
			const db = new Proxy(env.DB, {
				get: (t, k) =>
					k === 'prepare' ? (q: string) => (seen.push(q), t.prepare(q)) : (Reflect.get(t, k, t).bind?.(t) ?? Reflect.get(t, k, t)),
			});
			return { env: { ...env, DB: db } as Env, scans: () => seen.filter((q) => q.includes('CROSS JOIN')).length };
		};
		const now = Date.now();
		await env.DB.prepare("DELETE FROM settlements_task_state WHERE task = 'topUpSlots'").run();
		const first = createKernel(plugins);
		const a = counting();
		for (let i = 0; i < 10; i++) await first.tasks.get('settlements.topUpSlots')!.run({ kernel: first, env: a.env, now });
		expect(a.scans()).toBeGreaterThan(0);
		const scansOfFirst = a.scans();
		await first.tasks.get('settlements.topUpSlots')!.run({ kernel: first, env: a.env, now: now + 7_200_000 });
		expect(a.scans()).toBe(scansOfFirst); // an hour later: no scan
		// A new isolate (another kernel): one small read of the sizes done, no scan.
		const second = createKernel(plugins);
		const b = counting();
		await second.tasks.get('settlements.topUpSlots')!.run({ kernel: second, env: b.env, now });
		expect(b.scans()).toBe(0);
	});

	it('rejects a wrong GM password and non-GM access to GM routes', async () => {
		expect((await client().post('/api/auth/login', { username: 'gm', password: 'nope' })).status).toBe(401);
		const gm = await loginGM();
		const { player } = await newPlayer(gm, 'alice');
		expect((await player.get('/api/invites')).status).toBe(403);
		expect((await player.get('/api/gm/config')).status).toBe(403);
	});

	it('only registers with a valid, unused invite', async () => {
		const gm = await loginGM();
		const p = client();
		expect((await p.post('/api/auth/register', { username: 'bob', password: 'hunter2hunter2' })).status).toBe(403);

		const invite = await gm.post('/api/invites', { maxUses: 1, note: 'for bob' });
		expect(invite.body.link).toContain(`?invite=${invite.body.code}`);
		// Codes are accepted however they are pasted.
		const sloppy = invite.body.code.toLowerCase().replace('-', ' ');
		expect((await p.post('/api/auth/register', { username: 'bob', password: 'hunter2hunter2', inviteCode: sloppy })).status).toBe(201);
		const again = await client().post('/api/auth/register', {
			username: 'carol',
			password: 'hunter2hunter2',
			inviteCode: invite.body.code,
		});
		expect(again.body.error.code).toBe('invalid_invite');

		const list = await gm.get('/api/invites');
		expect(list.body.find((i: { code: string }) => i.code === invite.body.code).uses).toBe(1);
	});

	it('gives the invite use back when registration fails later', async () => {
		const gm = await loginGM();
		await newPlayer(gm, 'dave');
		const invite = await gm.post('/api/invites', {});
		const taken = await client().post('/api/auth/register', { username: 'DAVE', password: 'hunter2hunter2', inviteCode: invite.body.code });
		expect(taken.status).toBe(409);
		expect(
			(await client().post('/api/auth/register', { username: 'erin', password: 'hunter2hunter2', inviteCode: invite.body.code })).status,
		).toBe(201);
	});

	it('stops accepting revoked invites and supports logout', async () => {
		const gm = await loginGM();
		const invite = await gm.post('/api/invites', { maxUses: 5 });
		expect((await gm.del(`/api/invites/${invite.body.code}`)).status).toBe(200);
		expect(
			(await client().post('/api/auth/register', { username: 'frank', password: 'hunter2hunter2', inviteCode: invite.body.code })).status,
		).toBe(403);
		await gm.post('/api/auth/logout');
		expect((await gm.get('/api/auth/me')).body.user).toBeNull();
	});
});

describe('passwords', () => {
	it('the GM logs in with the initial password once, must change it before playing, then uses only the new one', async () => {
		// As if the GM had never logged in (other tests did): its account has no password yet.
		await loginGM();
		await env.DB.prepare("UPDATE accounts_users SET password_hash = '', password_salt = '', must_change = 0 WHERE username = 'gm'").run();
		const gm = client();
		expect((await gm.post('/api/auth/login', { username: 'gm', password: 'wrong-password' })).status).toBe(401);
		const first = await gm.post('/api/auth/login', { username: 'gm', password: 'gm-test-password' });
		expect(first.status).toBe(200);
		expect(first.body.user).toMatchObject({ gm: true, mustChangePassword: true });
		expect((await gm.get('/api/auth/me')).body.user.mustChangePassword).toBe(true);
		// No playing until it is changed; GM routes stay open (the first run imports the map as the GM).
		expect(await gm.get('/api/state')).toMatchObject({
			status: 403,
			body: { error: { code: 'password_change_required', text: { text: 'accounts.Change your password first' } } },
		});
		expect((await gm.get('/api/gm/players')).status).toBe(200);
		// Wrong current password, too short, or the same one: refused.
		expect((await gm.post('/api/auth/password', { oldPassword: 'nope', newPassword: 'a-new-password' })).body.error.code).toBe(
			'wrong_password',
		);
		expect((await gm.post('/api/auth/password', { oldPassword: 'gm-test-password', newPassword: 'short' })).body.error).toMatchObject({
			code: 'bad_password',
			message: 'Password: 8-128 characters',
		});
		expect(
			(await gm.post('/api/auth/password', { oldPassword: 'gm-test-password', newPassword: 'gm-test-password' })).body.error.code,
		).toBe('same_password');
		const changed = await gm.post('/api/auth/password', { oldPassword: 'gm-test-password', newPassword: 'a-new-password' });
		expect(changed.status).toBe(200);
		expect(changed.body.user.mustChangePassword).toBeUndefined();
		expect((await gm.get('/api/gm/players')).status).toBe(200);
		// From now on GM_PASSWORD is nothing special: only the new password works.
		expect((await client().post('/api/auth/login', { username: 'gm', password: 'gm-test-password' })).status).toBe(401);
		const again = client();
		expect((await again.post('/api/auth/login', { username: 'gm', password: 'a-new-password' })).body.user).toMatchObject({ gm: true });
		expect((await again.get('/api/gm/players')).status).toBe(200);
		expect((await again.post('/api/auth/password', { oldPassword: 'a-new-password', newPassword: GM_PASSWORD })).status).toBe(200);
	});

	it('every account changes its own password; other sessions end, the old password stops working', async () => {
		const gm = await loginGM();
		const { player } = await newPlayer(gm, 'pw-changer');
		const elsewhere = client();
		expect((await elsewhere.post('/api/auth/login', { username: 'pw-changer', password: 'hunter2hunter2' })).status).toBe(200);
		expect((await client().post('/api/auth/password', { oldPassword: 'x', newPassword: 'yyyyyyyy' })).status).toBe(401);
		expect((await player.post('/api/auth/password', { oldPassword: 'hunter2hunter2' })).body.error.code).toBe('bad_payload');
		expect((await player.post('/api/auth/password', { oldPassword: 'hunter2hunter2', newPassword: 'correct-horse' })).status).toBe(200);
		expect((await player.get('/api/auth/me')).body.user.username).toBe('pw-changer');
		expect((await elsewhere.get('/api/auth/me')).body.user).toBeNull();
		expect((await client().post('/api/auth/login', { username: 'pw-changer', password: 'hunter2hunter2' })).status).toBe(401);
		expect((await client().post('/api/auth/login', { username: 'pw-changer', password: 'correct-horse' })).status).toBe(200);
	});
});

describe('playing and GM tools', () => {
	it('sends static views once by version: baked per rules, again only when a rule they read changes', async () => {
		const gm = await loginGM();
		const { player } = await newPlayer(gm, 'statics');
		const version = async () =>
			((await player.get('/api/state?views=mail.unread')).body.statics as Record<string, string>)['realms.catalog'];
		const v1 = await version();
		expect(v1).toBeTruthy();
		const res = await player.raw(`/api/static/realms.catalog/${v1}`);
		expect(res.headers.get('cache-control')).toContain('immutable');
		const catalog = (await res.json()) as RowsData;
		expect(catalog.sections.length).toBeGreaterThan(3);
		expect(catalog.sections[0].rows[0].lines?.some((l) => l.tag === 'undiscovered')).toBe(true);
		// A rule it does not read: the same version (not baked again).
		expect((await gm.put('/api/gm/config/buildings.speed', { value: 2 })).status).toBe(200);
		expect(await version()).toBe(v1);
		// One it reads (the realms' difficulty): a new version.
		expect((await gm.put('/api/gm/config/starter-realms.difficulty', { value: { 'black-wind': 0.5 } })).status).toBe(200);
		const v2 = await version();
		expect(v2).not.toBe(v1);
		expect((await player.raw(`/api/static/realms.catalog/${v2}`)).status).toBe(200);
		expect((await gm.del('/api/gm/config/starter-realms.difficulty')).status).toBe(200);
		expect((await gm.del('/api/gm/config/buildings.speed')).status).toBe(200);
	});

	it('leaves the resource pool out while it is unchanged (stamps): the client counts on; a change sends it again', async () => {
		const gm = await loginGM();
		const { player } = await newPlayer(gm, 'stamped');
		const first = await player.get('/api/state?views=resources.pool,settlements.mine');
		const pool = first.body.views['resources.pool'] as { at: number; amounts: Record<string, number> };
		expect(pool.at).toEqual(expect.any(Number));
		const stamps = encodeURIComponent(JSON.stringify(keyedStamps(first.body)));
		const again = await player.get(`/api/state?views=resources.pool,settlements.mine&stamps=${stamps}`);
		expect(Object.keys(again.body.views)).not.toContain('resources.pool');
		expect(keyedStamps(again.body, keyedStamps(first.body))).toEqual(keyedStamps(first.body));
		// Spending writes the pool: it comes again, with a new stamp.
		const settlement = (await player.get('/api/state?views=settlements.mine')).body.views['settlements.mine'][0].id;
		await gm.post(`/api/gm/players/${(await player.get('/api/auth/me')).body.user.id}/command`, {
			type: 'resources.grant',
			payload: { resource: 'wood', amount: 5, settlement },
		});
		const after = await player.get(`/api/state?views=resources.pool&stamps=${stamps}`);
		expect(Object.keys(after.body.views)).toEqual(['resources.pool']);
		expect(after.body.stamps['resources.pool']).not.toBe(first.body.stamps['resources.pool']);
	});

	it('sends the City page views again only after a change (stamps: commits, the pool settled, the rules, events due)', async () => {
		const gm = await loginGM();
		const { player } = await newPlayer(gm, 'slotted');
		const city = 'buildings.state,settlements.outline,resources.sources';
		const first = await player.get(`/api/state?views=${city}`);
		expect(first.body.views['buildings.state']).toMatchObject({ slots: expect.any(Array), queue: expect.any(Object) });
		const stamps = encodeURIComponent(JSON.stringify(keyedStamps(first.body)));
		const again = await player.get(`/api/state?views=${city}&stamps=${stamps}`);
		expect(again.body.views).toEqual({});
		// Building something commits: the slots come again.
		const s = (await player.get('/api/state?views=settlements.mine')).body.views['settlements.mine'][0];
		const state = first.body.views['buildings.state'] as BuildingsState;
		const inner = state.settlement.districts.find((d) => d.type === 'inner')!;
		const used = new Set([...state.slots, ...state.construction].filter((x) => x.district === inner.id).map((x) => x.slot));
		const free = Array.from({ length: inner.slots }, (_, slot) => slot).find((slot) => !used.has(slot));
		const built = await player.post(`/api/command?views=${city}&stamps=${stamps}`, {
			type: 'buildings.construct',
			payload: { settlement: s.id, district: inner.id, slot: free, building: 'warehouse' },
		});
		// Paid (the pool settled: production too) and built (a commit: slots and the board).
		expect(Object.keys(built.body.views).sort()).toEqual(['buildings.state', 'resources.sources', 'settlements.outline']);
		expect(built.body.stamps['buildings.state']).not.toBe(first.body.stamps['buildings.state']);
	});

	it('answers a command with what it changed only: reading mail sends neither the inbox, nor unchanged views, nor the static versions again', async () => {
		const gm = await loginGM();
		const { player, id } = await newPlayer(gm, 'readmail');
		const views = 'settlements.mine,mail.unread,mail.inbox,mail.notice';
		const first = await player.get(`/api/state?views=${views}`);
		expect(first.body.statics).toBeDefined();
		const held = keyedStamps(first.body);
		const query = `views=${views}&stamps=${encodeURIComponent(JSON.stringify(held))}&sync=${id}&sv=${first.body.staticsVersion}`;
		const read = await player.post(`/api/command?${query}`, { type: 'mail.read', payload: { all: true } });
		// Only the small unread view may come again (its table was written); the rest is confirmed (empty stamps).
		expect(Object.keys(read.body.views).filter((v) => v !== 'mail.unread')).toEqual([]);
		expect(read.body.stamps['settlements.mine']).toBe('');
		expect(read.body.stamps['mail.inbox']).toBe('');
		expect(read.body.statics).toBeUndefined();
		expect(read.body.staticsVersion).toBe(first.body.staticsVersion);
		// The browser's stamps after it: the held ones under the new key.
		const after = keyedStamps(read.body, held);
		expect(after['mail.inbox'].split('~')[1]).toBe(held['mail.inbox'].split('~')[1]);
	});

	it("answers an unchanged sync from one D1 call: the session, the rules and the player's record read together", async () => {
		const gm = await loginGM();
		const { player, id } = await newPlayer(gm, 'quietsync');
		// The bands' views (every page) and the City page's.
		const views = 'settlements.mine,resources.pool,mail.unread,timeline.due,armies.due,buildings.state,settlements.outline';
		const first = await player.get(`/api/state?views=${views}`);
		expect(first.body.player).toBe(id);
		const path = `/api/state?views=${views}&stamps=${encodeURIComponent(JSON.stringify(keyedStamps(first.body)))}&sync=${id}`;
		const again = await player.get(path);
		expect(again.body.views).toEqual({});
		expect(keyedStamps(again.body, keyedStamps(first.body))).toEqual(keyedStamps(first.body));
		// The route itself, over a database counting its calls (as the Worker's entry wraps it: src/index.ts).
		const kernel = getKernel();
		const route = matchRoute(kernel, 'GET', '/api/state')!;
		const call = async () => {
			const counted = d1Calls(env.DB);
			const request = new Request(`${BASE}${path}`, { headers: { cookie: player.cookie() } });
			const res = await route.route.handler({
				kernel,
				request,
				env: { ...env, DB: packReads(counted.db) },
				exec: undefined as never,
				params: {},
				url: new URL(request.url),
				services: kernel.services,
			});
			return { body: (await res.json()) as { views: Record<string, unknown> }, sent: counted.sent };
		};
		await call(); // this test's isolate: the rules worked out once
		const counted = await call();
		expect(counted.body.views).toEqual({});
		expect(counted.sent).toHaveLength(1);
		// Claiming to be someone else: not answered from their record (worked out as usual).
		const other = await player.get(path.replace(`sync=${id}`, `sync=${crypto.randomUUID()}`));
		expect(keyedStamps(other.body, keyedStamps(first.body))).toEqual(keyedStamps(first.body));
	});

	it('loads the state for an account without a settlement and lets it found a capital', async () => {
		const gm = await loginGM();
		const { player, id } = await newPlayer(gm, 'olga');
		// Simulate an account created before the city system existed.
		await env.DB.prepare(
			"DELETE FROM world_map_tiles WHERE entity IN (SELECT 'settlement:' || id FROM settlements_settlements WHERE owner_id = ?)",
		)
			.bind(id)
			.run();
		await env.DB.prepare('DELETE FROM settlements_settlements WHERE owner_id = ?').bind(id).run();

		const state = await player.get('/api/state?views=resources.pool,settlements.outline');
		expect(state.status).toBe(200);
		expect(state.body.views['resources.pool']).toBeNull();
		expect(state.body.views['settlements.outline']).toBeNull();
		const forms = (await player.get('/api/state?views=forms.patches&placement=global')).body.views['forms.patches'].forms;
		expect(forms.map((f: { command: string }) => f.command)).toEqual(['settlements.foundCapital']);
		expect((await player.post('/api/command', { type: 'settlements.foundCapital' })).status).toBe(200);
		// Plus the built-in income since founding: real time passes in HTTP tests (slow machines included).
		const food = (await player.get('/api/state?views=resources.pool')).body.views['resources.pool'].amounts.food;
		expect(food).toBeGreaterThanOrEqual(500);
		expect(food).toBeLessThan(510);
	});

	it('gives every new account a capital and plays through the API', async () => {
		const gm = await loginGM();
		const { player } = await newPlayer(gm, 'gina');
		const mine = (await player.get('/api/state?views=settlements.mine')).body.views['settlements.mine'];
		expect(mine).toHaveLength(1);
		expect(mine[0].kind).toBe('capital');
		expect((await gm.get('/api/state?views=settlements.mine')).body.views['settlements.mine']).toHaveLength(1); // the GM too

		const detail = (await player.get('/api/state?views=settlements.outline')).body.views['settlements.outline'];
		const outerCity = detail.districts.find((d: { type: string }) => d.type === 'outer');
		const built = await player.post('/api/command?views=resources.pool', {
			type: 'buildings.construct',
			payload: { settlement: detail.id, district: outerCity.id, slot: 0, building: 'farm' },
		});
		expect(built.status).toBe(200);
		// A level-1 farm costs no food (buildings.ownResourceFreeUntil), only wood.
		// + built-in income since founding (real time, however slow the machine)
		expect(built.body.views['resources.pool'].amounts.food).toBeGreaterThanOrEqual(500);
		expect(built.body.views['resources.pool'].amounts.food).toBeLessThan(510);
		expect(built.body.views['resources.pool'].amounts.wood).toBeGreaterThanOrEqual(439.5);
		expect(built.body.views['resources.pool'].amounts.wood).toBeLessThan(450);

		// Someone else's settlement is invisible.
		const { player: other } = await newPlayer(gm, 'gino');
		expect((await other.get(`/api/state?views=settlements.outline&settlement=${detail.id}`)).status).toBe(404);
		expect((await player.post('/api/command', { type: 'resources.grant', payload: { resource: 'gold', amount: 1e9 } })).status).toBe(404);
	});

	it('offers server-driven forms that submit as commands', async () => {
		const gm = await loginGM();
		const { player } = await newPlayer(gm, 'hana');
		const { views } = (await player.get('/api/state?views=forms.patches,settlements.outline&placement=settlement')).body;
		// What is available (data), put together with the forms' fixed part (static) as the browser does.
		const forms = resolveForms(await formsInput(), views['forms.patches'])!;
		expect(forms.map((f: { command: string }) => f.command)).toEqual(expect.arrayContaining(['settlements.rename']));
		// The same forms as an instance of the view in a sync for other views (what the client does), malformed ones left out.
		const instances = encodeURIComponent(
			JSON.stringify([
				{ key: 'here', view: 'forms.patches', params: { placement: 'settlement' } },
				{ key: 7 },
				{ key: 'x', view: 'nope', params: {} },
			]),
		);
		const synced = (await player.get(`/api/state?views=resources.pool&instances=${instances}`)).body;
		expect(Object.keys(synced.views)).toEqual(['resources.pool']);
		expect(Object.keys(synced.instances)).toEqual(['here']);
		expect(synced.instances.here.forms.map((f: { command: string }) => f.command)).toEqual(forms.map((f) => f.command));
		const rename = forms.find((f) => f.command === 'settlements.rename')!;
		expect(rename.fields.find((f) => f.name === 'settlement')!.default).toBe(views['settlements.outline'].id);
		// Submitting a form is just a command with the field values as payload.
		await player.post('/api/command', {
			type: 'settlements.rename',
			payload: { settlement: views['settlements.outline'].id, name: 'Hanabad' },
		});
		expect((await player.get('/api/state?views=settlements.mine')).body.views['settlements.mine'][0].name).toBe('Hanabad');
		// Global placement: nothing to do for a player who has a capital.
		expect((await player.get('/api/state?views=forms.patches&placement=global')).body.views['forms.patches'].forms).toEqual([]);
	});

	it('serves GM action forms for a target player, grouped by plugin, without JSON', async () => {
		const gm = await loginGM();
		const { player, id } = await newPlayer(gm, 'fiona');
		expect((await player.get(`/api/gm/forms?player=${id}`)).status).toBe(403);
		const forms = resolveForms(await formsInput(), (await gm.get(`/api/gm/forms?player=${id}`)).body)!;
		const grant = forms.find((f) => f.command === 'resources.grant')!;
		expect(grant.owner).toBe('resources');
		expect(forms.map((f) => f.owner)).toEqual(expect.arrayContaining(['resources', 'research', 'items', 'npc-camps']));
		const settlement = grant.fields.find((f) => f.name === 'settlement')!.options![0].value;
		// Submitting = the form's field values as payload, run for the target player.
		expect(
			(
				await gm.post(`/api/gm/players/${id}/command?views=resources.pool`, {
					type: 'resources.grant',
					payload: { settlement, resource: 'gold', amount: 50 },
				})
			).status,
		).toBe(200);
		const tech = forms.find((f) => f.command === 'research.setLevel')!.fields.find((f) => f.name === 'tech')!.options!;
		expect(tech.map((o) => o.value)).toContain('economics');
		// A privileged form never shows up for players.
		expect((await player.get('/api/state?views=forms.patches&placement=gm')).body.views['forms.patches'].forms).toEqual([]);
	});

	it('lets the GM change rules live, act on players, report and audit', async () => {
		const gm = await loginGM();
		const { player, id } = await newPlayer(gm, 'hank');
		const pool = async () => (await player.get('/api/state?views=resources.pool')).body.views['resources.pool'];

		expect((await gm.put('/api/gm/config/buildings.speed', { value: -1 })).status).toBe(400);
		expect((await gm.put('/api/gm/config/resources.baseCapacity', { value: 5000 })).status).toBe(200);
		expect((await pool()).capacity).toBe(5000);
		const config = await gm.get('/api/gm/config');
		expect(config.body.find((c: { key: string }) => c.key === 'resources.baseCapacity')).toMatchObject({ overridden: true, value: 5000 });

		const grant = await gm.post(`/api/gm/players/${id}/command?views=resources.pool`, {
			type: 'resources.grant',
			payload: { resource: 'wood', amount: 50 },
		});
		// 500 + 50, and what it made since (counted on to the answer's time).
		expect(grant.body.views['resources.pool'].amounts.wood).toBeGreaterThanOrEqual(550);
		expect(grant.body.views['resources.pool'].amounts.wood).toBeLessThan(555);
		expect((await gm.get('/api/gm/commands')).body.map((c: { type: string }) => c.type)).toEqual(
			expect.arrayContaining(['resources.grant', 'buildings.raiseCap', 'settlements.addOuterBeyondTech']),
		);
		expect((await gm.del('/api/gm/config/resources.baseCapacity')).status).toBe(200);
		expect((await pool()).capacity).toBe(1000);

		const reports = await gm.get('/api/gm/reports');
		expect(reports.body.map((r: { id: string }) => r.id)).toEqual(
			expect.arrayContaining(['resources.top', 'settlements.list', 'buildings.levels']),
		);
		const list = await gm.post('/api/gm/reports/settlements.list', { params: { owner: id } });
		expect(list.body).toEqual([expect.objectContaining({ playerId: id, username: 'hank', kind: 'capital' })]);
		expect((await player.post('/api/gm/reports/settlements.list', { params: {} })).status).toBe(403);

		const audit = await gm.get('/api/gm/audit');
		expect(audit.body.map((a: { action: string }) => a.action)).toEqual(
			expect.arrayContaining(['config.set', 'config.reset', 'player.command']),
		);
	});
});

describe('puzzles (GM screen)', () => {
	it('only the GM edits puzzles; pictures are checked by their bytes and stored under their hash; players see live ones', async () => {
		expect((await client().get('/api/gm/puzzles')).status).toBe(401);
		const gm = await loginGM();
		const { player } = await newPlayer(gm, 'puzzler');
		expect((await player.get('/api/gm/puzzles')).status).toBe(403);
		const screen = (await gm.get('/api/gm/puzzles')).body;
		expect(screen.kinds.map((k: { id: string }) => k.id)).toEqual(
			expect.arrayContaining(['resources', 'item', 'troops', 'hero-female', 'hero', 'pool']),
		);
		expect(screen.sites.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining(['realms', 'npc-camps', 'bandits', 'pvp']));

		// A PNG's signature, then anything: accepted as a PNG, stored under its hash; anything else refused.
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
		expect((await player.postRaw('/api/gm/puzzles/image', png)).status).toBe(403);
		expect((await gm.postRaw('/api/gm/puzzles/image', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).status).toBe(400);
		const { key } = (await gm.postRaw('/api/gm/puzzles/image', png)).body;
		expect(key).toMatch(/^puzzles\/[0-9a-f]{20}\.png$/);
		expect((await env.FILES.head(key))?.httpMetadata?.contentType).toBe('image/png');
		expect((await client().raw(`/api/files/${key}`)).status).toBe(401);
		expect((await player.raw(`/api/files/${key}`)).status).toBe(200);
		const put = await gm.post('/api/gm/puzzles', {
			name: 'Harbour',
			grid: 3,
			status: 'live',
			image: key,
			limit: 2,
			duplicate: null,
			drops: [{ pieces: [0, 1], sites: ['npc-camps'], chance: 0.01, value: 1 }],
			rewards: [{ kind: 'resources', config: { gold: 1000 } }],
		});
		expect(put.status).toBe(200);
		await gm.post('/api/gm/puzzles', {
			name: 'Draft',
			grid: 2,
			status: 'draft',
			image: null,
			limit: 1,
			duplicate: null,
			drops: [],
			rewards: [],
		});
		const state = (await player.get('/api/state?views=settlements.mine')).body;
		const version = state.statics['puzzles.catalog'];
		const catalog = (await player.get(`/api/static/puzzles.catalog/${version}`)).body as Record<
			string,
			{ name: string; grid: number; limit: number }
		>;
		expect(Object.values(catalog).map((p) => p.name)).toContain('Harbour');
		expect(Object.values(catalog).map((p) => p.name)).not.toContain('Draft');
	});
});

describe('personalization (site icon and title)', () => {
	const svg = (body: string) =>
		new TextEncoder().encode(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8">${body}</svg>`);
	const site = async (p: ReturnType<typeof client>) => {
		const version = (await p.get('/api/state?views=settlements.mine')).body.statics['personalization.site'];
		return (await p.get(`/api/static/personalization.site/${version}`)).body as PersonalizationSite;
	};

	it('pictures are known by their bytes; SVGs with anything but drawing are refused', () => {
		const types = ['png', 'svg', 'webp', 'ico'] as const;
		expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), types)).toBe('png');
		expect(sniffImage(new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]), types)).toBe('ico');
		expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), types)).toBeNull();
		expect(sniffImage(svg('<rect width="8" height="8"/>'), types)).toBe('svg');
		expect(sniffImage(new TextEncoder().encode('<html><svg></svg></html>'), types)).toBeNull();
		expect(unsafeSvg(svg('<defs><path id="a" d="M0 0h8v8z"/></defs><use href="#a"/><rect fill="url(#a)"/>'))).toBe(false);
		for (const bad of [
			'<script>alert(1)</script>',
			'<rect onload="alert(1)"/>',
			'<a href="https://example.com"><rect/></a>',
			'<use xlink:href = "data:image/svg+xml;base64,AAAA"/>',
			'<image href="javascript:alert(1)"/>',
			'<foreignObject><div/></foreignObject>',
			'<style>@import "https://example.com/x.css";</style>',
			'<rect style="fill:url(https://example.com/x)"/>',
			'<set attributeName="href" to="javascript:alert(1)"/>',
		])
			expect(unsafeSvg(svg(bad)), bad).toBe(true);
		expect(unsafeSvg(new TextEncoder().encode('<!DOCTYPE svg [<!ENTITY x "y">]><svg/>'))).toBe(true);
	});

	it('the default icon is a static file of the site: linked from the page, and every built-in one exists', () => {
		const links = [...indexHtml.matchAll(/<link rel="[^"]*icon[^"]*" href="([^"]+)"/g)].map((m) => m[1]);
		expect(links).toEqual(['/favicon.svg', '/favicon.ico']);
		for (const link of links) expect(publicFiles).toContain(link);
		for (const id of ['keep', 'swords', 'shield', 'banner', 'crown', 'compass', 'mountain', 'tent'])
			expect(publicFiles).toContain(`/icons/${id}.svg`);
		expect(publicRaw['../public/favicon.svg']).toBe(publicRaw['../public/icons/keep.svg']);
	});

	it('only the GM chooses; the choice reaches everyone through the static view; uploads are checked and served to all', async () => {
		expect((await client().get('/api/gm/personalization')).status).toBe(401);
		expect((await client().postRaw('/api/gm/personalization/image', svg('<rect/>'))).status).toBe(401);
		const gm = await loginGM();
		const { player } = await newPlayer(gm, `dresser${crypto.randomUUID().slice(0, 6)}`);
		expect((await player.get('/api/gm/personalization')).status).toBe(403);
		expect((await player.postRaw('/api/gm/personalization/image', svg('<rect/>'))).status).toBe(403);
		expect((await player.put('/api/gm/config/personalization.icon', { value: 'crown' })).status).toBe(403);

		// Nothing chosen: the first built-in icon, the game's own title.
		await gm.del('/api/gm/config/personalization.icon');
		await gm.del('/api/gm/config/personalization.title');
		const screen = (await gm.get('/api/gm/personalization')).body as PersonalizationGmData;
		const iconField = screen.fields.find((f) => f.key === 'personalization.icon')!;
		expect(iconField).toMatchObject({ kind: 'image', value: 'keep', default: 'keep', overridden: false });
		expect(iconField.choices.map((c) => c.url)).toContain('/icons/crown.svg');
		expect(await site(player)).toEqual({ 'personalization.icon': { url: '/icons/keep.svg' }, 'personalization.title': { text: '' } });

		// A built-in one and a title: kept, sent to players; unknown ones refused.
		expect((await gm.put('/api/gm/config/personalization.icon', { value: 'crown' })).status).toBe(200);
		expect((await gm.put('/api/gm/config/personalization.icon', { value: 'nope' })).status).toBe(400);
		expect((await gm.put('/api/gm/config/personalization.icon', { value: 'personalization/../../x.svg' })).status).toBe(400);
		expect((await gm.put('/api/gm/config/personalization.title', { value: 'x'.repeat(61) })).status).toBe(400);
		expect((await gm.put('/api/gm/config/personalization.title', { value: '  Iron Realm ' })).status).toBe(200);
		expect((await gm.get('/api/gm/personalization')).body.fields[0]).toMatchObject({ value: 'crown', overridden: true });
		expect(await site(player)).toEqual({
			'personalization.icon': { url: '/icons/crown.svg' },
			'personalization.title': { text: 'Iron Realm' },
		});

		// Uploads: by their bytes, active SVGs refused, stored under their hash, served to anyone (sandboxed SVG).
		expect((await gm.postRaw('/api/gm/personalization/image', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]))).status).toBe(400);
		expect((await gm.postRaw('/api/gm/personalization/image', svg('<script>alert(1)</script>'))).status).toBe(400);
		expect((await gm.postRaw('/api/gm/personalization/image', new Uint8Array(256 * 1024 + 1).fill(0x20))).status).toBe(400);
		const { key } = (await gm.postRaw('/api/gm/personalization/image', svg('<rect width="8" height="8" fill="#b7791f"/>'))).body;
		expect(key).toMatch(/^personalization\/[0-9a-f]{20}\.svg$/);
		const served = await client().raw(`/api/files/${key}`);
		expect(served.status).toBe(200);
		expect(served.headers.get('content-type')).toBe('image/svg+xml');
		expect(served.headers.get('content-security-policy')).toContain('sandbox');
		await served.arrayBuffer();
		expect((await client().raw('/api/files/personalization/0123456789abcdef0123.svg')).status).toBe(404);
		expect((await gm.get('/api/gm/personalization')).body.uploads).toContain(key);
		expect((await gm.put('/api/gm/config/personalization.icon', { value: key })).status).toBe(200);
		expect((await site(player))['personalization.icon']).toEqual({ file: key });

		const audit = (await gm.get('/api/gm/audit')).body.map((a: { action: string }) => a.action);
		expect(audit).toEqual(expect.arrayContaining(['personalization.image', 'config.set']));
		await gm.del('/api/gm/config/personalization.icon');
		await gm.del('/api/gm/config/personalization.title');
	});
});

describe('GM messages to everyone', () => {
	it('broadcasts a mail to every player and sets the announcement banner; players cannot', async () => {
		const gm = await loginGM();
		const name = `bc${crypto.randomUUID().slice(0, 8)}`;
		const { player } = await newPlayer(gm, name);
		expect((await player.post('/api/gm/mail/broadcast', { title: 'Hi', body: 'x' })).status).toBe(403);
		expect((await gm.post('/api/gm/mail/broadcast', { title: '', body: 'x' })).status).toBe(400);

		// Attachments are checked by their kinds when sent.
		const bad = await gm.post('/api/gm/mail/broadcast', { title: 'Gift', body: 'x', attachments: [{ kind: 'nothing-such', config: {} }] });
		expect(bad.status).toBe(400);
		expect(
			(await gm.post('/api/gm/mail/broadcast', { title: 'Gift', body: 'x', attachments: [{ kind: 'coupons', config: { amount: 0 } }] }))
				.status,
		).toBe(400);

		const sent = await gm.post('/api/gm/mail/broadcast', {
			title: 'Server news',
			body: 'Line one\nLine two',
			attachments: [{ kind: 'coupons', config: { amount: 50 } }],
		});
		expect(sent.status).toBe(200);
		expect(sent.body.id).toMatch(/^b-/);
		const inbox = (await player.get('/api/state?views=mail.inbox')).body.views['mail.inbox'];
		const mail = inbox.messages.find((m: { id: string }) => m.id === sent.body.id);
		expect(mail).toMatchObject({
			kind: 'mail.broadcast',
			title: { text: 'i18n.{0}', vars: { 0: 'Server news' } },
			read: false,
			gift: 'unclaimed',
		});
		const whole = (await player.get(`/api/state?views=mail.message&mail=${sent.body.id}`)).body.views['mail.message'];
		expect(whole.report.lines.map((l: { text: { vars: { 0: string } } }) => l.text.vars[0])).toEqual(['Line one', 'Line two']);
		expect(whole.attachments).toHaveLength(1);
		// At its own address, kept by the browser for good; only for whom it is (a later account, nobody: not found / 401).
		const own = await player.raw(`/api/mail/${sent.body.id}`);
		expect(own.status).toBe(200);
		expect(own.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
		expect(await own.json()).toEqual(whole);
		const { player: later } = await newPlayer(gm, `bl${crypto.randomUUID().slice(0, 8)}`);
		const theirs = await later.raw(`/api/mail/${sent.body.id}`);
		expect(theirs.status).toBe(404);
		expect(theirs.headers.get('cache-control')).toBe('no-store');
		expect((await player.get(`/api/mail/${crypto.randomUUID()}`)).status).toBe(404);
		expect((await client().get(`/api/mail/${sent.body.id}`)).status).toBe(401);
		// Claimed once.
		expect((await player.post('/api/command', { type: 'mail.claim', payload: { id: sent.body.id } })).status).toBe(200);
		expect((await player.post('/api/command', { type: 'mail.claim', payload: { id: sent.body.id } })).status).toBe(400);
		const wallet = (await player.get('/api/state?views=shop.wallet')).body.views['shop.wallet'];
		expect(wallet.balance).toBe(50);

		expect((await gm.put('/api/gm/config/mail.announcement', { value: 'Maintenance at 22:00' })).status).toBe(200);
		// The text as data; the banner is made in the browser (web/plugins/mail/announcement.ts).
		const notice = (await player.get('/api/state?views=mail.notice')).body.views['mail.notice'];
		expect(notice).toEqual({ text: 'Maintenance at 22:00' });
		expect(announcementBanner(notice)).toMatchObject({ text: { vars: { 0: 'Maintenance at 22:00' } }, key: 'Maintenance at 22:00' });
		expect((await gm.del('/api/gm/config/mail.announcement')).status).toBe(200);
		expect((await player.get('/api/state?views=mail.notice')).body.views['mail.notice']).toBeNull();
		const audit = await gm.get('/api/gm/audit');
		expect(audit.body.find((a: { action: string }) => a.action === 'mail.broadcast').detail).toMatchObject({
			id: sent.body.id,
			attachments: [{ kind: 'coupons', config: { amount: 50 } }],
		});
	});
});
