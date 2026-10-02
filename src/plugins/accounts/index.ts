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
import { definePlugin, gameErrors, type Kernel } from '../../kernel';
import { json, readJson } from '../../lib/http';
import type { User } from '../../shared/api';
import { hashPassword, randomToken, safeEqual, sha256, verifyPassword } from './crypto';
import i18nCsv from './data/i18n.csv?raw';

const fail = gameErrors('accounts');

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
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
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
				// D1 allows at most 100 bound parameters per query.
				for (let i = 0; i < ids.length; i += 100) {
					const chunk = ids.slice(i, i + 100);
					const { results } = await db
						.prepare(`SELECT id, username FROM accounts_users WHERE id IN (${chunk.map(() => '?').join(',')})`)
						.bind(...chunk)
						.all<{ id: string; username: string }>();
					for (const r of results) out[r.id] = r.username;
				}
				return out;
			},
		};

		ctx.services.provide('accounts', service);
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
				// 200 with `user: null` when logged out: it's a question, not a failure.
				return json({ user: await service.current(request, env) });
			},
		});

		ctx.routes.add({
			method: 'POST',
			path: '/api/auth/login',
			async handler({ kernel, request, env }) {
				const { username, password } = credentials(await readJson(request));
				const invalid = fail('invalid_login', 'Wrong username or password', 401);

				// The GM account gets its initial password from GM_PASSWORD, once: created on the first login, or
				// still without a password. From then on it logs in like everyone, against its own hash.
				let createdGm: string | null = null;
				if (isGmName(env, username)) {
					const stored = await env.DB.prepare('SELECT password_hash FROM accounts_users WHERE username = ?')
						.bind(username)
						.first<{ password_hash: string }>();
					if (!stored?.password_hash) {
						if (!env.GM_PASSWORD || !(await safeEqual(password, env.GM_PASSWORD))) throw invalid;
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
				if (!row || !(await verifyPassword(password, row.password_hash, row.password_salt))) throw invalid;
				const gm = isGmName(env, row.username);

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
