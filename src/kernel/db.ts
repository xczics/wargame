/**
 * The engine's database: one layer between the code and D1 doing what three proxies did before (1.6.0, changelog 490).
 *
 * - **Reads packed into one round trip** (was `packReads`): the SELECTs a request issues while nothing else is in flight
 *   (every view of a sync starts at once, each with its first queries) go to D1 as one `batch`, not one call each. Every
 *   D1 call costs the Worker CPU of its own besides the query (measured 2026-10-21), so fewer calls is less CPU. Only
 *   SELECTs wait (a few microtask hops); `run`, `raw`, `batch` and `exec` go at once, after the reads queued before them
 *   have been answered, so a write never overtakes a read issued before it. A failing batch is sent again one
 *   statement at a time, so each caller gets its own answer or error.
 * - **Statements that know what they are** (was `recording`): each holds its SQL and bound values, for `coalesce`
 *   (merging single-row INSERTs) and for the tables a commit wrote.
 * - **Reads noted** for the view or memo preparing them (was a proxy in `readApi`, reads.ts).
 *
 * What a statement's SQL means (reads or writes, which tables, a mergeable INSERT's parts) is worked out once per SQL
 * text and kept (`infoOf`): statements repeat, and parsing them on every request was most of what the proxies cost
 * (the code runs interpreted on most requests: docs/workers-performance.md §1). Statements are plain objects, not
 * proxies; the binding's own statement is prepared only when one is sent.
 */
import { noteTables, tablesRead, tableWritten } from './reads';

/** What a statement's SQL says, worked out once per text. */
export interface SqlInfo {
	read: boolean;
	/** The tables it reads (`FROM` / `JOIN`, the engine's own aside). */
	reads: readonly string[];
	/** The table it writes (`UNKNOWN` for a read or one that cannot be told). */
	written: string;
	/** Every `<word>_<word>` it names, for keeping each table's statements in order when merging. */
	names: ReadonlySet<string>;
	/** A single-row INSERT `coalesce` may merge: the parts around its one `(?, …)`. */
	insert?: { head: string; table: string; columns: number; row: string; tail: string };
}

const READ = /^\s*SELECT\b/i;
/** `INSERT [OR …] INTO t (cols) VALUES (?, …)` plus an optional ON CONFLICT clause: one row, mergeable. */
const SINGLE_INSERT =
	/^\s*(INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*)(\(\s*\?(?:\s*,\s*\?)*\s*\))(\s+ON\s+CONFLICT[\s\S]*)?\s*$/i;
const NAMES = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/gi;

const infos = new Map<string, SqlInfo>();
export function infoOf(sql: string): SqlInfo {
	let info = infos.get(sql);
	if (info) return info;
	const read = READ.test(sql);
	const m = read ? null : SINGLE_INSERT.exec(sql);
	info = {
		read,
		reads: tablesRead(sql),
		written: read ? tableWritten(undefined) : tableWritten(sql),
		names: new Set((sql.match(NAMES) ?? []).map((t) => t.toLowerCase())),
		...(m ? { insert: { head: m[1], table: m[2].toLowerCase(), columns: m[3].split(',').length, row: m[4], tail: m[5] ?? '' } } : {}),
	};
	// Statements built with a varying `IN (…)` are many texts: keep the cache in bounds.
	if (infos.size < 5000) infos.set(sql, info);
	return info;
}

interface Queued {
	statement: Statement;
	resolve: (r: D1Result<unknown>) => void;
	reject: (err: unknown) => void;
}

/** Most statements in one batch (D1's limit per call is far higher; this only keeps a reply's size in bounds). */
const MAX_BATCH = 50;
/** Microtask hops before the queue goes. */
const HOPS = 4;

/** A statement of the engine's database: its SQL, values and meaning; the binding's own made when it is sent. */
export class Statement {
	private made?: D1PreparedStatement;
	constructor(
		readonly db: EngineDb,
		readonly sql: string,
		readonly values: unknown[],
		readonly info: SqlInfo,
	) {}
	/** The binding's statement (what D1's `batch` is given). */
	real(): D1PreparedStatement {
		if (!this.made) {
			const s = this.db.raw.prepare(this.sql);
			this.made = this.values.length ? s.bind(...this.values) : s;
		}
		return this.made;
	}
	bind(...values: unknown[]): Statement {
		return new Statement(this.db, this.sql, values, this.info);
	}
	all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		return this.info.read ? (this.db.enqueue(this) as Promise<D1Result<T>>) : this.db.after(() => this.real().all<T>());
	}
	async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
		if (!this.info.read) return this.db.after(() => (column === undefined ? this.real().first<T>() : this.real().first<T>(column)));
		const row = ((await this.db.enqueue(this)).results[0] ?? null) as Record<string, unknown> | null;
		return (column === undefined ? row : row ? (row[column] ?? null) : null) as T | null;
	}
	run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
		return this.db.after(() => this.real().run<T>());
	}
	raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
		return this.db.after(() => this.real().raw<T>(options as { columnNames: false }) as Promise<T[]>);
	}
}

/** The engine's database over a binding (see the top). */
export class EngineDb {
	private queue: Queued[] = [];
	private sending: Promise<unknown> = Promise.resolve();
	private due = false;
	constructor(readonly raw: D1Database) {}

	prepare(sql: string): Statement {
		const info = infoOf(sql);
		noteTables(info.reads);
		return new Statement(this, sql, [], info);
	}
	async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
		await this.settled().catch(() => {});
		return this.raw.batch<T>(statements.map((s) => (s instanceof Statement ? s.real() : s)));
	}
	async exec(query: string): Promise<D1ExecResult> {
		await this.settled().catch(() => {});
		return this.raw.exec(query);
	}
	withSession(...args: Parameters<D1Database['withSession']>) {
		return this.raw.withSession(...args);
	}
	dump() {
		return (this.raw as unknown as { dump(): Promise<ArrayBuffer> }).dump();
	}

	/** A read, answered with the others queued in this turn (one batch). */
	enqueue(statement: Statement): Promise<D1Result<unknown>> {
		return new Promise((resolve, reject) => {
			this.queue.push({ statement, resolve, reject });
			if (this.due) return;
			this.due = true;
			// A few promise hops later: the views started together have issued their first reads by then.
			let hops = HOPS;
			const later = () => (!this.due ? undefined : --hops > 0 ? queueMicrotask(later) : void this.flush());
			queueMicrotask(later);
		});
	}
	/** `fn` once the reads queued so far are answered (anything that is not a queued read). */
	async after<T>(fn: () => Promise<T>): Promise<T> {
		await this.settled().catch(() => {});
		return fn();
	}
	private settled() {
		return this.queue.length ? this.flush() : this.sending;
	}
	private send(list: Queued[]) {
		if (list.length === 1) {
			const [q] = list;
			return q.statement.real().all().then(q.resolve, q.reject);
		}
		return this.raw.batch(list.map((q) => q.statement.real())).then(
			(results) => list.forEach((q, i) => q.resolve(results[i])),
			// One bad statement fails them all: each on its own, for its own answer.
			() => Promise.all(list.map((q) => q.statement.real().all().then(q.resolve, q.reject))),
		);
	}
	private flush() {
		this.due = false;
		const list = this.queue;
		this.queue = [];
		const sent: Promise<unknown>[] = [];
		for (let i = 0; i < list.length; i += MAX_BATCH) sent.push(this.send(list.slice(i, i + MAX_BATCH)));
		this.sending = Promise.all([this.sending, ...sent]);
		return this.sending;
	}
}

/** The engine's database over `db` (itself when it already is one). */
export function engineDb(db: D1Database): D1Database {
	return (db instanceof EngineDb ? db : new EngineDb(db)) as unknown as D1Database;
}

/** A statement's SQL, values and meaning, when it was prepared on the engine's database. */
export const statementOf = (s: object): Statement | undefined => (s instanceof Statement ? s : undefined);
/** The SQL of a statement prepared on the engine's database (undefined otherwise). */
export const sqlOf = (s: object): string | undefined => statementOf(s)?.sql;
