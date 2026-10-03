/**
 * Usage log, for estimating what the game would cost on Cloudflare: requests, D1 rows read / written,
 * database size and (measured outside, by the local server) CPU time, summed per period and logged.
 *
 * Only for local runs and Docker with the option on (`USAGE_LOG`: "on" = every 4 hours, or a number of
 * minutes; set by scripts/dev.mjs). Production never has it: the variable is not in wrangler.jsonc (the
 * check script refuses it there), and the table `usage_periods` is created here, never by a migration.
 *
 * Not a game plugin: it wraps the database binding for every request, below the kernel.
 */

/** Variables the local server sets when the option is on (not part of the generated `Env`). */
interface UsageVars {
	USAGE_LOG?: string;
	/** Shared with the local server, which reports the runtime's CPU time with it. */
	USAGE_TOKEN?: string;
}

const DEFAULT_MINUTES = 240;

/** Minutes per period, or 0 when the option is off. */
export function usageMinutes(env: Env): number {
	const raw = (env as Env & UsageVars).USAGE_LOG?.trim().toLowerCase();
	if (!raw || raw === 'off' || raw === '0' || raw === 'false') return 0;
	if (raw === 'on' || raw === 'true' || raw === 'yes') return DEFAULT_MINUTES;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? n : DEFAULT_MINUTES;
}

/** What this isolate counted since it last wrote to the table. */
const counted = { requests: 0, commands: 0, rowsRead: 0, rowsWritten: 0, cpuMs: 0, dbBytes: 0 };

const count = (meta: Partial<D1Meta> | undefined) => {
	if (!meta) return;
	counted.rowsRead += meta.rows_read ?? 0;
	counted.rowsWritten += meta.rows_written ?? 0;
	if (meta.size_after) counted.dbBytes = meta.size_after;
};

/** The real statement behind a counted one (D1's `batch` takes only its own). */
const originals = new WeakMap<object, D1PreparedStatement>();

function meterStatement(s: D1PreparedStatement): D1PreparedStatement {
	const counted = new Proxy(s, {
		get(target, key) {
			if (key === 'bind') return (...values: unknown[]) => meterStatement(target.bind(...values));
			if (key === 'all' || key === 'run')
				return async () => {
					const r = await target[key]();
					count(r.meta);
					return r;
				};
			// `first` has no meta: the same query through `all`, its first row.
			if (key === 'first')
				return async (column?: string) => {
					const r = await target.all<Record<string, unknown>>();
					count(r.meta);
					const row = r.results[0] ?? null;
					return column === undefined ? row : row ? (row[column] ?? null) : null;
				};
			const v = Reflect.get(target, key, target);
			return typeof v === 'function' ? v.bind(target) : v;
		},
	});
	originals.set(counted, s);
	return counted;
}

function meterDatabase(db: D1Database): D1Database {
	return new Proxy(db, {
		get(target, key) {
			if (key === 'prepare') return (query: string) => meterStatement(target.prepare(query));
			if (key === 'batch')
				return async (statements: D1PreparedStatement[]) => {
					const results = await target.batch(statements.map((s) => originals.get(s) ?? s));
					for (const r of results) count(r.meta);
					return results;
				};
			const v = Reflect.get(target, key, target);
			return typeof v === 'function' ? v.bind(target) : v;
		},
	});
}

/** For one request: counted, with a database that counts its rows. Unchanged when the option is off. */
export function meterRequest(env: Env, url: URL): Env {
	if (!usageMinutes(env)) return env;
	counted.requests++;
	if (url.pathname === '/api/command') counted.commands++;
	return { ...env, DB: meterDatabase(env.DB) };
}

/** The local server reports the runtime's CPU time: `POST /api/usage/cpu` { "ms": n } with the token. */
export async function usageRoute(request: Request, env: Env, url: URL): Promise<Response | null> {
	if (url.pathname !== '/api/usage/cpu' || !usageMinutes(env)) return null;
	const token = (env as Env & UsageVars).USAGE_TOKEN;
	if (request.method !== 'POST' || !token || request.headers.get('authorization') !== `Bearer ${token}`)
		return new Response('Forbidden', { status: 403 });
	const body = (await request.json().catch(() => null)) as { ms?: unknown } | null;
	const ms = Number(body?.ms);
	if (!Number.isFinite(ms) || ms < 0 || ms > 1e9) return new Response('Bad request', { status: 400 });
	counted.cpuMs += ms;
	return new Response(null, { status: 204 });
}

interface PeriodRow {
	start: number;
	requests: number;
	commands: number;
	rows_read: number;
	rows_written: number;
	cpu_ms: number;
	db_bytes: number;
}

/** Cloudflare's free plan, for comparison in the log (developers.cloudflare.com/workers/platform/pricing). */
const FREE = { requestsPerDay: 100_000, rowsReadPerDay: 5_000_000, rowsWrittenPerDay: 100_000, cpuMsPerRequest: 10, dbBytes: 5e9 };

/**
 * Every minute (the cron): add what was counted to this period's row, and log every period that has ended
 * and was not logged yet. Its own queries are not counted.
 */
export async function flushUsage(env: Env, now: number): Promise<void> {
	const minutes = usageMinutes(env);
	if (!minutes) return;
	const db = env.DB;
	const period = minutes * 60_000;
	const start = Math.floor(now / period) * period;
	await db
		.prepare(
			`CREATE TABLE IF NOT EXISTS usage_periods (
				start INTEGER PRIMARY KEY, minutes INTEGER NOT NULL,
				requests INTEGER NOT NULL DEFAULT 0, commands INTEGER NOT NULL DEFAULT 0,
				rows_read INTEGER NOT NULL DEFAULT 0, rows_written INTEGER NOT NULL DEFAULT 0,
				cpu_ms REAL NOT NULL DEFAULT 0, db_bytes INTEGER NOT NULL DEFAULT 0, logged INTEGER NOT NULL DEFAULT 0
			)`,
		)
		.run();
	const c = { ...counted };
	Object.assign(counted, { requests: 0, commands: 0, rowsRead: 0, rowsWritten: 0, cpuMs: 0 });
	await db
		.prepare(
			`INSERT INTO usage_periods (start, minutes, requests, commands, rows_read, rows_written, cpu_ms, db_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (start) DO UPDATE SET requests = requests + excluded.requests, commands = commands + excluded.commands,
			   rows_read = rows_read + excluded.rows_read, rows_written = rows_written + excluded.rows_written,
			   cpu_ms = cpu_ms + excluded.cpu_ms, db_bytes = MAX(db_bytes, excluded.db_bytes)`,
		)
		.bind(start, minutes, c.requests, c.commands, c.rowsRead, c.rowsWritten, c.cpuMs, c.dbBytes)
		.run();
	const { results } = await db
		.prepare('SELECT * FROM usage_periods WHERE logged = 0 AND start < ? ORDER BY start')
		.bind(start)
		.all<PeriodRow>();
	for (const p of results) {
		console.log(JSON.stringify(usageLine(p, minutes)));
		await db.prepare('UPDATE usage_periods SET logged = 1 WHERE start = ?').bind(p.start).run();
	}
}

/** One log line: the period's counts, per day, and as a share of the free plan. */
export function usageLine(p: PeriodRow, minutes: number) {
	const perDay = (n: number) => Math.round((n * 1440) / minutes);
	const cpuPerRequest = p.requests ? p.cpu_ms / p.requests : 0;
	const share = (n: number, of: number) => `${Math.round((n / of) * 1000) / 10}%`;
	return {
		usage: {
			from: new Date(p.start).toISOString(),
			minutes,
			requests: p.requests,
			commands: p.commands,
			rowsRead: p.rows_read,
			rowsWritten: p.rows_written,
			dbBytes: p.db_bytes,
			// The runtime process's CPU over the period, idle time included: an upper bound per request.
			cpuMsEstimate: Math.round(p.cpu_ms),
		},
		perDay: { requests: perDay(p.requests), rowsRead: perDay(p.rows_read), rowsWritten: perDay(p.rows_written) },
		ofFreePlan: {
			requests: share(perDay(p.requests), FREE.requestsPerDay),
			rowsRead: share(perDay(p.rows_read), FREE.rowsReadPerDay),
			rowsWritten: share(perDay(p.rows_written), FREE.rowsWrittenPerDay),
			cpuPerRequest: `${Math.round(cpuPerRequest * 10) / 10} ms of ${FREE.cpuMsPerRequest} ms`,
			storage: share(p.db_bytes, FREE.dbBytes),
		},
	};
}
