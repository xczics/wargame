/** End-to-end through the Worker, D1 (accounts/invites/GM) and the player Durable Object. */
import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import type { RowsData } from '../src/shared/ui';
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

	it('serves the map ground in chunks for players, cached by the browser for good (the URL has the version)', async () => {
		expect((await client().raw('/api/terrain/chunk?v=1&cx=0&cy=0')).status).toBe(401);
		const gm = await loginGM();
		const res = await gm.raw('/api/terrain/chunk?v=1&cx=0&cy=0');
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toContain('immutable');
		expect([0, 1024]).toContain((await res.text()).length); // 1024 codes, or empty: all the default terrain
		expect((await gm.raw('/api/terrain/chunk?v=1&cx=99&cy=0')).status).toBe(400);
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

	it('returns JSON 404 for unknown API routes', async () => {
		expect((await client().get('/api/does-not-exist')).status).toBe(404);
	});
});

describe('accounts & invites', () => {
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
		const first = await player.get('/api/state?views=resources.pool,mail.unread');
		const pool = first.body.views['resources.pool'] as { at: number; amounts: Record<string, number> };
		expect(pool.at).toEqual(expect.any(Number));
		const stamps = encodeURIComponent(JSON.stringify(first.body.stamps));
		const again = await player.get(`/api/state?views=resources.pool,mail.unread&stamps=${stamps}`);
		expect(Object.keys(again.body.views)).toEqual(['mail.unread']);
		expect(again.body.stamps).toEqual(first.body.stamps);
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
		const city = 'buildings.slots,settlements.districts,resources.production';
		const first = await player.get(`/api/state?views=${city}`);
		expect(first.body.views['buildings.slots']).toMatchObject({ base: 'buildings.catalog' });
		const stamps = encodeURIComponent(JSON.stringify(first.body.stamps));
		const again = await player.get(`/api/state?views=${city}&stamps=${stamps}`);
		expect(again.body.views).toEqual({});
		// Building something commits: the slots come again.
		const s = (await player.get('/api/state?views=settlements.mine')).body.views['settlements.mine'][0];
		const detail = (await player.get('/api/state?views=settlements.detail')).body.views['settlements.detail'];
		const inner = detail.districts.find((d: { type: string }) => d.type === 'inner');
		const free = inner.slots.find((x: { current: unknown; construction: unknown }) => !x.current && !x.construction).slot;
		const built = await player.post(`/api/command?views=${city}&stamps=${stamps}`, {
			type: 'buildings.construct',
			payload: { settlement: s.id, district: inner.id, slot: free, building: 'warehouse' },
		});
		// Paid (the pool settled: production too) and built (a commit: slots and the board).
		expect(Object.keys(built.body.views).sort()).toEqual(['buildings.slots', 'resources.production', 'settlements.districts']);
		expect(built.body.stamps['buildings.slots']).not.toBe(first.body.stamps['buildings.slots']);
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

		const state = await player.get('/api/state');
		expect(state.status).toBe(200);
		expect(state.body.views['resources.pool']).toBeNull();
		expect(state.body.views['settlements.detail']).toBeNull();
		const forms = (await player.get('/api/state?views=ui.forms&placement=global')).body.views['ui.forms'];
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

		const detail = (await player.get('/api/state?views=settlements.detail')).body.views['settlements.detail'];
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
		expect((await other.get(`/api/state?views=settlements.detail&settlement=${detail.id}`)).status).toBe(404);
		expect((await player.post('/api/command', { type: 'resources.grant', payload: { resource: 'gold', amount: 1e9 } })).status).toBe(404);
	});

	it('offers server-driven forms that submit as commands', async () => {
		const gm = await loginGM();
		const { player } = await newPlayer(gm, 'hana');
		const { views } = (await player.get('/api/state?views=ui.forms,settlements.detail&placement=settlement')).body;
		const forms = views['ui.forms'];
		expect(forms.map((f: { command: string }) => f.command)).toEqual(expect.arrayContaining(['settlements.rename']));
		// The same forms as an instance of the view in a sync for other views (what the client does), malformed ones left out.
		const instances = encodeURIComponent(
			JSON.stringify([
				{ key: 'here', view: 'ui.forms', params: { placement: 'settlement' } },
				{ key: 7 },
				{ key: 'x', view: 'nope', params: {} },
			]),
		);
		const synced = (await player.get(`/api/state?views=resources.pool&instances=${instances}`)).body;
		expect(Object.keys(synced.views)).toEqual(['resources.pool']);
		expect(Object.keys(synced.instances)).toEqual(['here']);
		expect(synced.instances.here.map((f: { command: string }) => f.command)).toEqual(forms.map((f: { command: string }) => f.command));
		const rename = forms.find((f: { command: string }) => f.command === 'settlements.rename');
		expect(rename.fields.find((f: { name: string }) => f.name === 'settlement').default).toBe(views['settlements.detail'].id);
		// Submitting a form is just a command with the field values as payload.
		await player.post('/api/command', {
			type: 'settlements.rename',
			payload: { settlement: views['settlements.detail'].id, name: 'Hanabad' },
		});
		expect((await player.get('/api/state?views=settlements.mine')).body.views['settlements.mine'][0].name).toBe('Hanabad');
		// Global placement: nothing to do for a player who has a capital.
		expect((await player.get('/api/state?views=ui.forms&placement=global')).body.views['ui.forms']).toEqual([]);
	});

	it('serves GM action forms for a target player, grouped by plugin, without JSON', async () => {
		const gm = await loginGM();
		const { player, id } = await newPlayer(gm, 'fiona');
		expect((await player.get(`/api/gm/forms?player=${id}`)).status).toBe(403);
		const forms = (await gm.get(`/api/gm/forms?player=${id}`)).body as {
			command: string;
			owner: string;
			fields: { name: string; options?: { value: string }[] }[];
		}[];
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
		expect((await player.get('/api/state?views=ui.forms&placement=gm')).body.views['ui.forms']).toEqual([]);
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
		expect(grant.body.views['resources.pool'].amounts.wood).toBeCloseTo(550, 0);
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

describe('GM messages to everyone', () => {
	it('broadcasts a mail to every player and sets the announcement banner; players cannot', async () => {
		const gm = await loginGM();
		const name = `bc${crypto.randomUUID().slice(0, 8)}`;
		const { player } = await newPlayer(gm, name);
		expect((await player.post('/api/gm/mail/broadcast', { title: 'Hi', body: 'x' })).status).toBe(403);
		expect((await gm.post('/api/gm/mail/broadcast', { title: '', body: 'x' })).status).toBe(400);

		const sent = await gm.post('/api/gm/mail/broadcast', { title: 'Server news', body: 'Line one\nLine two' });
		expect(sent.status).toBe(200);
		expect(sent.body.sent).toBeGreaterThanOrEqual(1);
		const inbox = (await player.get('/api/state?views=mail.inbox')).body.views['mail.inbox'];
		const mail = inbox.messages.find((m: { kind: string }) => m.kind === 'mail.broadcast');
		expect(mail).toMatchObject({ title: { text: 'i18n.{0}', vars: { 0: 'Server news' } }, read: false });
		expect(mail.report.lines.map((l: { text: { vars: { 0: string } } }) => l.text.vars[0])).toEqual(['Line one', 'Line two']);

		expect((await gm.put('/api/gm/config/mail.announcement', { value: 'Maintenance at 22:00' })).status).toBe(200);
		const banner = (await player.get('/api/state?views=mail.announcement')).body.views['mail.announcement'];
		expect(banner).toMatchObject({ text: { vars: { 0: 'Maintenance at 22:00' } }, key: 'Maintenance at 22:00' });
		expect((await gm.del('/api/gm/config/mail.announcement')).status).toBe(200);
		expect((await player.get('/api/state?views=mail.announcement')).body.views['mail.announcement']).toBeNull();
		const audit = await gm.get('/api/gm/audit');
		expect(audit.body.map((a: { action: string }) => a.action)).toContain('mail.broadcast');
	});
});
