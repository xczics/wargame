/** End-to-end through the Worker, D1 (accounts/invites/GM) and the player Durable Object. */
import { SELF } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
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
	};
}

async function loginGM() {
	const gm = client();
	expect((await gm.post('/api/auth/login', { username: 'gm', password: 'gm-test-password' })).status).toBe(200);
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
	});

	it('returns JSON 404 for unknown API routes', async () => {
		expect((await client().get('/api/does-not-exist')).status).toBe(404);
	});
});

describe('accounts & invites', () => {
	it('requires login to play', async () => {
		expect((await client().get('/api/state')).status).toBe(401);
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

describe('playing and GM tools', () => {
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
		expect((await player.get('/api/state?views=resources.pool')).body.views['resources.pool'].amounts.food).toBeCloseTo(500, 0);
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
		expect(built.body.views['resources.pool'].amounts.food).toBeCloseTo(500, 0); // + built-in income over a few ms
		expect(built.body.views['resources.pool'].amounts.wood).toBeCloseTo(440, 0);

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
		expect(forms.map((f: { command: string }) => f.command)).toEqual(
			expect.arrayContaining(['settlements.addOuter', 'settlements.rename']),
		);
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
