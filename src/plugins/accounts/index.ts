/**
 * Accounts: username/password login with server-side sessions (D1), and the GM.
 *
 * The GM is whoever logs in with `GM_USERNAME` + `GM_PASSWORD` (Worker secrets). The
 * GM row is created on first login; GM rights are re-checked against the secrets on
 * every request, so rotating/renaming them in the dashboard takes effect immediately.
 *
 * Registration is closed unless other plugins add registration guards (e.g. `invites`);
 * every guard must accept. Provides the `session` service so the rest of the game
 * only ever sees a player id.
 */
import { definePlugin, GameError, type Kernel } from '../../kernel';
import { json, readJson } from '../../lib/http';
import type { User } from '../../shared/api';
import { hashPassword, randomToken, safeEqual, sha256, verifyPassword } from './crypto';

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
	/** Usernames by user id, for decorating lists (unknown ids are omitted). */
	usernames(db: D1Database, ids: string[]): Promise<Record<string, string>>;
}

export interface SessionService {
	/** The player id for this request. Throws 401 when not logged in. */
	resolve(request: Request, env: Env): Promise<{ playerId: string }>;
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
	return { id: row.id, username: row.username, gm: !!row.session_gm && isGmName(env, row.username), createdAt: row.created_at };
}

function credentials(body: unknown): { username: string; password: string; fields: Record<string, unknown> } {
	const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
	const { username, password } = fields;
	if (typeof username !== 'string' || typeof password !== 'string') {
		throw new GameError('bad_credentials', 'username and password are required');
	}
	return { username: username.trim(), password, fields };
}

export default definePlugin({
	id: 'accounts',
	version: '0.1.0',
	description: 'Login, sessions, registration guards and the GM super user',
	setup(ctx) {
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
					`SELECT u.id, u.username, u.created_at, s.gm AS session_gm, s.expires_at
					 FROM accounts_sessions s JOIN accounts_users u ON u.id = s.user_id WHERE s.token_hash = ?`,
				)
					.bind(await sha256(token))
					.first<Row & { expires_at: number }>();
				if (!row || row.expires_at < Date.now()) return null;
				return toUser(env, row);
			},
			async require(request, env) {
				const user = await service.current(request, env);
				if (!user) throw new GameError('unauthorized', 'Please log in', 401);
				return user;
			},
			async requireGM(request, env) {
				const user = await service.require(request, env);
				if (!user.gm) throw new GameError('forbidden', 'GM only', 403);
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
				return { playerId: (await service.require(request, env)).id };
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
				const invalid = new GameError('invalid_login', 'Wrong username or password', 401);

				let createdGm: string | null = null;
				if (isGmName(env, username)) {
					if (!env.GM_PASSWORD || !(await safeEqual(password, env.GM_PASSWORD))) throw invalid;
					// First GM login creates the account; later logins reuse it.
					const gmId = crypto.randomUUID();
					const inserted = await env.DB.prepare(
						"INSERT INTO accounts_users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, '', '', ?) ON CONFLICT (username) DO NOTHING",
					)
						.bind(gmId, username, Date.now())
						.run();
					if (inserted.meta.changes) createdGm = gmId;
				}

				const row = await env.DB.prepare(
					'SELECT id, username, created_at, password_hash, password_salt FROM accounts_users WHERE username = ?',
				)
					.bind(username)
					.first<Row & { password_hash: string; password_salt: string }>();
				if (!row) throw invalid;
				const gm = isGmName(env, row.username);
				if (!gm && !(await verifyPassword(password, row.password_hash, row.password_salt))) throw invalid;

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
				if (!USERNAME.test(username)) throw new GameError('bad_username', 'Username: 3-20 letters, digits, _ or -');
				if (password.length < 8 || password.length > 128) throw new GameError('bad_password', 'Password: 8-128 characters');
				if (isGmName(env, username)) throw new GameError('username_taken', 'Username is taken', 409);
				if (guards.length === 0) throw new GameError('registration_closed', 'Registration is closed', 403);

				const exists = await env.DB.prepare('SELECT 1 FROM accounts_users WHERE username = ?').bind(username).first();
				if (exists) throw new GameError('username_taken', 'Username is taken', 409);

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
					if (err instanceof Error && /UNIQUE/i.test(err.message)) throw new GameError('username_taken', 'Username is taken', 409);
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
	},
});
