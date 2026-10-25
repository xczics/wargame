/**
 * Accounts: username/password login with server-side sessions (D1), and the GM.
 *
 * The GM is the account named `GM_USERNAME` (a Worker secret, checked on every request). It logs in
 * like any account, against its password hash. `GM_PASSWORD` is only its initial password (user
 * 2026-10-02: "GM在登录的待遇上要和普通用户保持一致哦。系统变量仅制定初始密码。"): while the GM account
 * has no password yet, logging in with it stores it and marks the account to change it first, so an
 * image can ship default credentials. An account marked so cannot play (the client shows only the screen
 * to change it); GM routes stay open, so the first run can import the map as the GM.
 * Every account changes its own password with the old one (`POST /api/auth/password`).
 *
 * Registration is closed unless other plugins add registration guards (e.g. `invites`);
 * every guard must accept. Provides the `session` service so the rest of the game
 * only ever sees a player id.
 */
import { chunks, csvRules, definePlugin, GameError, gameErrors, type Kernel, loadConfig, numberFields } from '../../kernel';
import { json, readJson } from '../../lib/http';
import type { User } from '../../shared/api';
import { hashPassword, randomToken, safeEqual, sha256, verifyPassword } from './crypto';
import i18nCsv from './data/i18n.csv?raw';
import rulesCsv from './data/rules.csv?raw';
import { uiTexts } from '../../shared/i18n';

const fail = gameErrors('accounts');
const text = uiTexts('accounts');

/** Design numbers (./data/rules.csv); GM overrides go on top. */
const RULES = csvRules(rulesCsv) as { login: LoginLimits };
type LoginLimits = {
	window: number;
	lock: number;
	perAccountIp: number;
	perAccount: number;
	perIp: number;
	registerPerIp: number;
	captchaAfter: number;
};

export type { User };

export interface RegistrationAttempt {
	env: Env;
	/** Id the new user will get if registration succeeds. */
	userId: string;
	username: string;
	/** The raw request body, so each guard can read its own field (e.g. `inviteCode`). */
	fields: Record<string, unknown>;
}

export interface RegistrationGuard {
	id: string;
	/**
	 * Accept (and reserve whatever is needed) or throw `GameError`. May return an undo
	 * function, called if registration fails afterwards.
	 */
	claim(attempt: RegistrationAttempt): Promise<void | (() => Promise<void>)>;
}

/** Runs after an account is created (registration or first GM login). Errors are logged, not fatal. */
export type AccountCreatedListener = (ctx: { kernel: Kernel; env: Env; userId: string }) => Promise<void>;

export interface AccountsService {
	addRegistrationGuard(guard: RegistrationGuard): void;
	onAccountCreated(listener: AccountCreatedListener): void;
	current(request: Request, env: Env): Promise<User | null>;
	/** Throws 401 when not logged in. */
	require(request: Request, env: Env): Promise<User>;
	/** Throws 401 / 403 unless the caller is the GM. */
	requireGM(request: Request, env: Env): Promise<User>;
	list(env: Env, options?: { limit?: number; offset?: number }): Promise<User[]>;
	get(env: Env, id: string): Promise<User | null>;
	/**
	 * End this request's session and open a plain (never GM) one for `userId`; returns the Set-Cookie
	 * header. Only for GM routes, after `requireGM` (e.g. "play as this player"): getting back to the
	 * GM takes logging out and in with the GM's credentials.
	 */
	switchSession(request: Request, env: Env, userId: string): Promise<string>;
	/** Usernames by user id, for decorating lists (unknown ids are omitted). */
	usernames(db: D1Database, ids: string[]): Promise<Record<string, string>>;
	/** When the account was made (null: no such account), e.g. which GM mail to everyone reaches it. Kept per isolate: it never changes. */
	joinedAt(db: D1Database, id: string): Promise<number | null>;
}

export interface SessionService {
	/** The player id for this request. Throws 401 when not logged in. */
	/** `gm`: the caller is the GM (for showing more; GM routes still call `requireGM`). */
	resolve(request: Request, env: Env): Promise<{ playerId: string; gm: boolean }>;
}

declare module '../../kernel' {
	interface ServiceMap {
		accounts: AccountsService;
		session: SessionService;
	}
}

const COOKIE = 'wg_session';
/** Accounts' creation times by id (`joinedAt`): they never change. */
const joined = new Map<string, number | null>();
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
// Expired sessions swept per minute: bounded so a backlog (first run after an upgrade) spreads over several runs.
const SWEEP_BATCH = 200;
const USERNAME = /^[A-Za-z0-9_-]{3,20}$/;

interface Row {
	id: string;
	username: string;
	created_at: number;
	must_change?: number;
	session_gm?: number;
}

function readCookie(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get('cookie') ?? '').split(';')) {
		const [k, ...v] = part.trim().split('=');
		if (k === name) return v.join('=');
	}
	return undefined;
}

function sessionCookie(request: Request, value: string, maxAge: number): string {
	const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
	return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

const isGmName = (env: Env, username: string) => !!env.GM_USERNAME && username.toLowerCase() === env.GM_USERNAME.toLowerCase();

function toUser(env: Env, row: Row): User {
	return {
		id: row.id,
		username: row.username,
		gm: !!row.session_gm && isGmName(env, row.username),
		createdAt: row.created_at,
		...(row.must_change ? { mustChangePassword: true } : {}),
	};
}

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
function checkPassword(password: string) {
	if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) throw fail('bad_password', 'Password: 8-128 characters');
}

function credentials(body: unknown): { username: string; password: string; fields: Record<string, unknown> } {
	const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
	const { username, password } = fields;
	if (typeof username !== 'string' || typeof password !== 'string') {
		throw fail('bad_credentials', 'username and password are required');
	}
	return { username: username.trim(), password, fields };
}

export default definePlugin({
	id: 'accounts',
	version: '0.1.0',
	description: 'Login, sessions, registration guards and the GM super user',
	dependsOn: ['ui', 'i18n'],
	tables: ['accounts_login_failures', 'accounts_sessions', 'accounts_users'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const guards: RegistrationGuard[] = [];
		const createdListeners: AccountCreatedListener[] = [];

		async function accountCreated(kernel: Kernel, env: Env, userId: string) {
			for (const listener of createdListeners) {
				await listener({ kernel, env, userId }).catch((err) => console.error('Account-created listener failed', err));
			}
		}

		async function openSession(request: Request, env: Env, userId: string, gm: boolean): Promise<string> {
			const token = randomToken();
			const now = Date.now();
			await env.DB.prepare('INSERT INTO accounts_sessions (token_hash, user_id, gm, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
				.bind(await sha256(token), userId, gm ? 1 : 0, now, now + SESSION_TTL_SECONDS * 1000)
				.run();
			return sessionCookie(request, token, SESSION_TTL_SECONDS);
		}

		const service: AccountsService = {
			addRegistrationGuard(guard) {
				guards.push(guard);
			},
			onAccountCreated: (listener) => void createdListeners.push(listener),
			async current(request, env) {
				const token = readCookie(request, COOKIE);
				if (!token) return null;
				const row = await env.DB.prepare(
					`SELECT u.id, u.username, u.created_at, u.must_change, s.gm AS session_gm, s.expires_at
					 FROM accounts_sessions s JOIN accounts_users u ON u.id = s.user_id WHERE s.token_hash = ?`,
				)
					.bind(await sha256(token))
					.first<Row & { expires_at: number }>();
				if (!row || row.expires_at < Date.now()) return null;
				return toUser(env, row);
			},
			async require(request, env) {
				const user = await service.current(request, env);
				if (!user) throw fail('unauthorized', 'Please log in', 401);
				return user;
			},
			async requireGM(request, env) {
				const user = await service.require(request, env);
				if (!user.gm) throw fail('forbidden', 'GM only', 403);
				return user;
			},
			async list(env, { limit = 100, offset = 0 } = {}) {
				const { results } = await env.DB.prepare('SELECT id, username, created_at FROM accounts_users ORDER BY created_at LIMIT ? OFFSET ?')
					.bind(Math.min(limit, 500), offset)
					.all<Row>();
				// `gm` here means "is the configured GM account", independent of any session.
				return results.map((r) => ({ ...toUser(env, r), gm: isGmName(env, r.username) }));
			},
			async get(env, id) {
				const row = await env.DB.prepare('SELECT id, username, created_at FROM accounts_users WHERE id = ?').bind(id).first<Row>();
				return row ? { ...toUser(env, row), gm: isGmName(env, row.username) } : null;
			},
			async switchSession(request, env, userId) {
				const token = readCookie(request, COOKIE);
				if (token)
					await env.DB.prepare('DELETE FROM accounts_sessions WHERE token_hash = ?')
						.bind(await sha256(token))
						.run();
				return openSession(request, env, userId, false);
			},
			async usernames(db, ids) {
				const out: Record<string, string> = {};
				for (const chunk of chunks(ids)) {
					const { results } = await db
						.prepare(`SELECT id, username FROM accounts_users WHERE id IN (${chunk.map(() => '?').join(',')})`)
						.bind(...chunk)
						.all<{ id: string; username: string }>();
					for (const r of results) out[r.id] = r.username;
				}
				return out;
			},
			async joinedAt(db, id) {
				const known = joined.get(id);
				if (known !== undefined) return known;
				const row = await db.prepare('SELECT created_at FROM accounts_users WHERE id = ?').bind(id).first<{ created_at: number }>();
				if (joined.size >= 10_000) joined.clear();
				// An id with no account (ids are never reused) stays without one.
				joined.set(id, row?.created_at ?? null);
				return row?.created_at ?? null;
			},
		};

		ctx.services.provide('accounts', service);

		// Sessions only expire when read; without this, abandoned ones (cleared cookies, other devices) pile up forever.
		// Failed logins of a day ago and more, not locked any more, go too.
		ctx.tasks.add({
			id: 'accounts.sessions',
			// Hourly is plenty.
			every: 60,
			async run({ env, now }) {
				await env.DB.batch([
					env.DB.prepare(
						'DELETE FROM accounts_sessions WHERE token_hash IN (SELECT token_hash FROM accounts_sessions WHERE expires_at < ? LIMIT ?)',
					).bind(now, SWEEP_BATCH),
					env.DB.prepare(
						'DELETE FROM accounts_login_failures WHERE key IN (SELECT key FROM accounts_login_failures WHERE first_at < ? AND locked_until < ? LIMIT ?)',
					).bind(now - 86_400_000, now, SWEEP_BATCH),
				]);
			},
		});

		/*
		 * Failed logins (user 2026-10-20: "做一下登录界面的最大重试保护"): counted by name and address together, by name alone
		 * (many addresses guessing one account) and by address alone (one address trying many); at a limit, logins there are
		 * refused for a while, before any password is checked (that hashing is the costly part). Unknown names count alike
		 * (nothing tells whether an account exists). A login that works clears its name-and-address count only.
		 */
		const loginLimits = ctx.config.define('loginLimits', {
			description:
				'Failed logins and registrations: counted over `window` minutes; at a limit, refused for `lock` minutes (0: no limit); past `captchaAfter`, a human check first.',
			default: () => RULES.login,
			parse: numberFields(() => RULES.login, 0, 1e6),
		});
		// Set by Cloudflare; elsewhere (local runs, Docker without a proxy) every request shares one address.
		const ipOf = (request: Request) => request.headers.get('CF-Connecting-IP') ?? 'unknown';
		/** What is counted, each key with its limit, and the address (for the human check). */
		type Counted = { ip: string; keys: (readonly [string, number])[] };
		const loginKeys = (request: Request, username: string, l: LoginLimits): Counted => {
			const ip = ipOf(request);
			return {
				ip,
				keys: [
					[`u:${username}|ip:${ip}`, l.perAccountIp],
					[`u:${username}`, l.perAccount],
					[`ip:${ip}`, l.perIp],
				],
			};
		};
		// Registering: a wrong invite code (user 2026-10-20: "注册界面也加上哈，避免爆破邀请码"), by address.
		const registerKeys = (request: Request, l: LoginLimits): Counted => {
			const ip = ipOf(request);
			return { ip, keys: [[`reg:ip:${ip}`, l.registerPerIp]] };
		};
		/** Cloudflare Turnstile, when both keys are set (the site key public, the secret a secret); else no human check. */
		type CaptchaEnv = Env & { TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET?: string };
		const captchaKey = (env: Env) => {
			const e = env as CaptchaEnv;
			return e.TURNSTILE_SITE_KEY && e.TURNSTILE_SECRET ? e.TURNSTILE_SITE_KEY : null;
		};
		async function human(env: Env, token: string, ip: string) {
			try {
				const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						secret: (env as CaptchaEnv).TURNSTILE_SECRET,
						response: token,
						...(ip !== 'unknown' ? { remoteip: ip } : {}),
					}),
				});
				return ((await res.json()) as { success?: boolean }).success === true;
			} catch {
				return false;
			}
		}
		/**
		 * Before anything is checked: refused while a key is locked; past `captchaAfter` recent failures on any key (user
		 * 2026-10-20: Turnstile "连续失败几次后，登录要先过人机验证"), only with a human check passed (`turnstile` in the body).
		 */
		async function admit(env: Env, c: Counted, limits: LoginLimits, now: number, token: unknown) {
			const { results } = await env.DB.prepare(
				`SELECT count, first_at, locked_until FROM accounts_login_failures WHERE key IN (${c.keys.map(() => '?').join(', ')})`,
			)
				.bind(...c.keys.map(([key]) => key))
				.all<{ count: number; first_at: number; locked_until: number }>();
			const until = Math.max(0, ...results.map((r) => r.locked_until).filter((t) => t > now));
			if (until) throw tooMany(until, now);
			const since = now - limits.window * 60_000;
			const recent = Math.max(0, ...results.filter((r) => r.first_at >= since).map((r) => r.count));
			if (!captchaKey(env) || !limits.captchaAfter || recent < limits.captchaAfter) return;
			if (typeof token !== 'string' || !token) throw fail('captcha_required', 'Please confirm you are human first', 401);
			if (!(await human(env, token, c.ip))) throw fail('captcha_failed', 'The human check failed: please try again', 403);
		}
		/** One more failure on each key (those with a limit), locking those that reach it. */
		async function failed(env: Env, c: Counted, limits: LoginLimits, now: number) {
			const since = now - limits.window * 60_000;
			const until = now + limits.lock * 60_000;
			const statements = c.keys
				.filter(([, limit]) => limit > 0)
				.map(([key, limit]) =>
					env.DB.prepare(
						`INSERT INTO accounts_login_failures (key, count, first_at, locked_until) VALUES (?1, 1, ?2, CASE WHEN ?5 <= 1 THEN ?4 ELSE 0 END)
						 ON CONFLICT (key) DO UPDATE SET
						   count = CASE WHEN first_at < ?3 THEN 1 ELSE count + 1 END,
						   first_at = CASE WHEN first_at < ?3 THEN ?2 ELSE first_at END,
						   locked_until = CASE WHEN (CASE WHEN first_at < ?3 THEN 1 ELSE count + 1 END) >= ?5 THEN ?4 ELSE locked_until END`,
					).bind(key, now, since, until, limit),
				);
			if (statements.length) await env.DB.batch(statements);
		}
		const tooMany = (until: number, now: number) =>
			fail(
				'too_many_attempts',
				text('Too many failed attempts: try again in {0} minutes', { 0: Math.max(1, Math.ceil((until - now) / 60_000)) }),
				429,
			);
		ctx.services.provide('session', {
			async resolve(request, env) {
				const user = await service.require(request, env);
				// No playing until an initial password is changed. GM routes stay open (user 2026-10-02: the first
				// run imports the map as the GM before anyone has logged in to change it); the client shows only
				// the screen to change it.
				if (user.mustChangePassword) throw fail('password_change_required', 'Change your password first', 403);
				return { playerId: user.id, gm: user.gm };
			},
		});

		ctx.routes.add({
			method: 'GET',
			path: '/api/auth/me',
			async handler({ request, env }) {
				// 200 with `user: null` when logged out: it's a question, not a failure. With the public key of the human check,
				// when there is one (the login screen shows it once asked).
				const captcha = captchaKey(env);
				return json({ user: await service.current(request, env), ...(captcha ? { captcha } : {}) });
			},
		});

		ctx.routes.add({
			method: 'POST',
			path: '/api/auth/login',
			async handler({ kernel, request, env }) {
				const { username, password, fields } = credentials(await readJson(request));
				const now = Date.now();
				const limits = loginLimits.get({ config: (await loadConfig(kernel, env)).values } as never);
				const counted = loginKeys(request, username, limits);
				await admit(env, counted, limits, now, fields.turnstile);
				// Counted, then refused (the count is written before the answer).
				const wrong = async () => {
					await failed(env, counted, limits, now);
					return fail('invalid_login', 'Wrong username or password', 401);
				};

				// The GM account gets its initial password from GM_PASSWORD, once: created on the first login, or
				// still without a password. From then on it logs in like everyone, against its own hash.
				let createdGm: string | null = null;
				if (isGmName(env, username)) {
					const stored = await env.DB.prepare('SELECT password_hash FROM accounts_users WHERE username = ?')
						.bind(username)
						.first<{ password_hash: string }>();
					if (!stored?.password_hash) {
						if (!env.GM_PASSWORD || !(await safeEqual(password, env.GM_PASSWORD))) throw await wrong();
						const { hash, salt } = await hashPassword(password);
						const gmId = crypto.randomUUID();
						const written = await env.DB.prepare(
							`INSERT INTO accounts_users (id, username, password_hash, password_salt, must_change, created_at) VALUES (?, ?, ?, ?, 1, ?)
							 ON CONFLICT (username) DO UPDATE SET password_hash = excluded.password_hash, password_salt = excluded.password_salt, must_change = 1
							 WHERE accounts_users.password_hash = ''
							 RETURNING id`,
						)
							.bind(gmId, username, hash, salt, Date.now())
							.first<{ id: string }>();
						if (written?.id === gmId) createdGm = gmId;
					}
				}

				const row = await env.DB.prepare(
					'SELECT id, username, created_at, must_change, password_hash, password_salt FROM accounts_users WHERE username = ?',
				)
					.bind(username)
					.first<Row & { password_hash: string; password_salt: string }>();
				if (!row || !(await verifyPassword(password, row.password_hash, row.password_salt))) throw await wrong();
				const gm = isGmName(env, row.username);
				await env.DB.prepare('DELETE FROM accounts_login_failures WHERE key = ?').bind(counted.keys[0][0]).run();

				if (createdGm) await accountCreated(kernel, env, createdGm);
				const cookie = await openSession(request, env, row.id, gm);
				return json({ user: { ...toUser(env, row), gm } }, { headers: { 'set-cookie': cookie } });
			},
		});

		ctx.routes.add({
			method: 'POST',
			path: '/api/auth/register',
			async handler({ kernel, request, env }) {
				const { username, password, fields } = credentials(await readJson(request));
				const now = Date.now();
				const limits = loginLimits.get({ config: (await loadConfig(kernel, env)).values } as never);
				const counted = registerKeys(request, limits);
				await admit(env, counted, limits, now, fields.turnstile);
				if (!USERNAME.test(username)) throw fail('bad_username', 'Username: 3-20 letters, digits, _ or -');
				checkPassword(password);
				if (isGmName(env, username)) throw fail('username_taken', 'Username is taken', 409);
				if (guards.length === 0) throw fail('registration_closed', 'Registration is closed', 403);

				const exists = await env.DB.prepare('SELECT 1 FROM accounts_users WHERE username = ?').bind(username).first();
				if (exists) throw fail('username_taken', 'Username is taken', 409);

				const userId = crypto.randomUUID();
				const undo: Array<() => Promise<void>> = [];
				try {
					for (const guard of guards) {
						const u = await guard.claim({ env, userId, username, fields });
						if (u) undo.push(u);
					}
					const { hash, salt } = await hashPassword(password);
					await env.DB.prepare('INSERT INTO accounts_users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)')
						.bind(userId, username, hash, salt, Date.now())
						.run();
				} catch (err) {
					for (const u of undo.reverse()) await u().catch((e) => console.error('Registration undo failed', e));
					if (err instanceof Error && /UNIQUE/i.test(err.message)) throw fail('username_taken', 'Username is taken', 409);
					// A guard said no (e.g. a wrong invite code): counted, so codes cannot be guessed at speed.
					if (err instanceof GameError) await failed(env, counted, limits, now);
					throw err;
				}

				await accountCreated(kernel, env, userId);
				const cookie = await openSession(request, env, userId, false);
				const user: User = { id: userId, username, gm: false, createdAt: Date.now() };
				return json({ user }, { status: 201, headers: { 'set-cookie': cookie } });
			},
		});

		ctx.routes.add({
			method: 'POST',
			path: '/api/auth/password',
			async handler({ request, env }) {
				// Any logged-in account, including one that must change its password first.
				const user = await service.current(request, env);
				if (!user) throw fail('unauthorized', 'Please log in', 401);
				const body = (await readJson(request)) as Record<string, unknown> | null;
				const { oldPassword, newPassword } = body ?? {};
				if (typeof oldPassword !== 'string' || typeof newPassword !== 'string')
					throw fail('bad_payload', 'oldPassword and newPassword are required');
				const row = await env.DB.prepare('SELECT password_hash, password_salt FROM accounts_users WHERE id = ?')
					.bind(user.id)
					.first<{ password_hash: string; password_salt: string }>();
				if (!row || !(await verifyPassword(oldPassword, row.password_hash, row.password_salt)))
					throw fail('wrong_password', 'The current password is wrong');
				checkPassword(newPassword);
				if (newPassword === oldPassword) throw fail('same_password', 'Choose a password different from the current one');
				const { hash, salt } = await hashPassword(newPassword);
				// Other sessions of the account end: whoever knew the old password is logged out.
				const token = readCookie(request, COOKIE) ?? '';
				await env.DB.batch([
					env.DB.prepare('UPDATE accounts_users SET password_hash = ?, password_salt = ?, must_change = 0 WHERE id = ?').bind(
						hash,
						salt,
						user.id,
					),
					env.DB.prepare('DELETE FROM accounts_sessions WHERE user_id = ? AND token_hash != ?').bind(user.id, await sha256(token)),
				]);
				const { mustChangePassword: _, ...changed } = user;
				return json({ user: changed });
			},
		});

		ctx.routes.add({
			method: 'POST',
			path: '/api/auth/logout',
			async handler({ request, env }) {
				const token = readCookie(request, COOKIE);
				if (token)
					await env.DB.prepare('DELETE FROM accounts_sessions WHERE token_hash = ?')
						.bind(await sha256(token))
						.run();
				return json({ ok: true }, { headers: { 'set-cookie': sessionCookie(request, '', 0) } });
			},
		});

		// Where its screens go (meta `ui`; the client has the widgets).
		const ui = ctx.services.get('ui');
		ui.band({ band: 'top', widget: 'auth.user' });
	},
});
