/** Failed logins and registrations with the human check on (src/plugins/accounts: Turnstile keys set, its answer mocked). */
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKernel, GameError, matchRoute } from '../src/kernel';
import { errorResponse } from '../src/lib/http';
import { plugins } from '../src/plugins';

const kernel = createKernel(plugins);
const keyed = { ...env, TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET: 'secret' } as unknown as Env;

/** Cloudflare's siteverify: "good" passes, anything else fails (recorded). */
function siteverify() {
	const tokens: string[] = [];
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const url = String(input instanceof Request ? input.url : input);
		if (!url.endsWith('/siteverify')) throw new Error(`unexpected fetch ${url}`);
		const { response } = JSON.parse(String(init?.body)) as { response: string };
		tokens.push(response);
		return Response.json({ success: response === 'good' });
	});
	return tokens;
}

async function call(e: Env, path: string, ip: string, body: unknown) {
	const request = new Request(`https://x${path}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
		body: JSON.stringify(body),
	});
	const url = new URL(request.url);
	const m = matchRoute(kernel, 'POST', url.pathname)!;
	try {
		const res = await m.route.handler({ kernel, request, env: e, exec: {} as never, params: m.params, url, services: kernel.services });
		return { status: res.status, code: null as string | null };
	} catch (err) {
		if (!(err instanceof GameError)) throw err;
		const res = errorResponse(err);
		return { status: res.status, code: ((await res.json()) as { error: { code: string } }).error.code };
	}
}

describe('login guard with the human check', () => {
	afterEach(() => vi.restoreAllMocks());

	it('asks for a human check after three failures; a wrong one is refused, a passed one lets the password be checked', async () => {
		const tokens = siteverify();
		const ip = `10.9.${Math.floor(Math.random() * 250)}.1`;
		const name = `nobody${crypto.randomUUID().slice(0, 6)}`;
		const login = (extra: object = {}) => call(keyed, '/api/auth/login', ip, { username: name, password: 'wrong-pass', ...extra });
		for (let i = 0; i < 3; i++) expect(await login()).toEqual({ status: 401, code: 'invalid_login' });
		expect(await login()).toEqual({ status: 401, code: 'captcha_required' });
		expect(await login({ turnstile: 'bad' })).toEqual({ status: 403, code: 'captcha_failed' });
		// Passed: the password is checked (and counted: the fifth failure for this name and address locks it).
		expect(await login({ turnstile: 'good' })).toEqual({ status: 401, code: 'invalid_login' });
		expect(await login({ turnstile: 'good' })).toEqual({ status: 401, code: 'invalid_login' });
		expect(await login({ turnstile: 'good' })).toEqual({ status: 429, code: 'too_many_attempts' });
		expect(tokens).toEqual(['bad', 'good', 'good']); // locked: not even asked
		// The meta of the login screen carries the public key.
		const me = await matchRoute(kernel, 'GET', '/api/auth/me')!.route.handler({
			kernel,
			request: new Request('https://x/api/auth/me'),
			env: keyed,
			exec: {} as never,
			params: {},
			url: new URL('https://x/api/auth/me'),
			services: kernel.services,
		});
		expect(await me.json()).toMatchObject({ user: null, captcha: 'site-key' });
	});

	it('counts wrong invite codes by address: a human check, then refused', async () => {
		siteverify();
		const ip = `10.8.${Math.floor(Math.random() * 250)}.1`;
		const register = (extra: object = {}) =>
			call(keyed, '/api/auth/register', ip, {
				username: `n${crypto.randomUUID().slice(0, 8)}`,
				password: 'hunter2hunter2',
				inviteCode: 'NOPE',
				...extra,
			});
		for (let i = 0; i < 3; i++) expect((await register()).status).toBeGreaterThanOrEqual(400);
		expect(await register()).toEqual({ status: 401, code: 'captcha_required' });
		for (let i = 0; i < 7; i++) expect((await register({ turnstile: 'good' })).code).not.toBe('too_many_attempts');
		expect(await register({ turnstile: 'good' })).toEqual({ status: 429, code: 'too_many_attempts' });
	});

	it('asks for nothing without the keys (local runs, Docker): only the counts and locks', async () => {
		const tokens = siteverify();
		const ip = `10.7.${Math.floor(Math.random() * 250)}.1`;
		const login = () => call(env as Env, '/api/auth/login', ip, { username: 'nobody-at-all', password: 'wrong-pass' });
		for (let i = 0; i < 5; i++) expect((await login()).code).toBe('invalid_login');
		expect((await login()).code).toBe('too_many_attempts');
		expect(tokens).toEqual([]);
	});
});
