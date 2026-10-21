/**
 * Reads packed into one round trip: the SELECTs a request issues while nothing else is in flight (every view of a
 * sync starts at once, each with its first queries) go to D1 as one `batch`, not one call each.
 *
 * Every D1 call costs the Worker CPU of its own besides the query (the binding's request, its headers, a tracing
 * span, the reply's decoding: measured 2026-10-21, more than a page's own code on a sync), so fewer calls is less CPU,
 * and less waiting too. Nothing changes for the code using the database: a statement's `all` / `first` answer as
 * before, each with its own rows.
 *
 * - Only SELECTs wait (until the current turn's promise chains have run: a timer of 0); `run`, `raw`, `batch` and
 *   anything else go at once, after the reads queued before them have been answered, so a write never overtakes a
 *   read issued before it.
 * - D1 runs a batch as one transaction, statement after statement: reads in it see one state of the database, as
 *   separate reads with nothing written between them would.
 * - A failing batch is sent again one statement at a time, so each caller gets its own answer or error.
 */

interface Queued {
	statement: D1PreparedStatement;
	resolve: (r: D1Result<unknown>) => void;
	reject: (err: unknown) => void;
}

const READ = /^\s*SELECT\b/i;
/** Packed databases and their statements, to the ones they stand for (a batch takes D1's own). */
const inner = new WeakMap<object, D1PreparedStatement>();
const packed = new WeakSet<object>();

/** Most statements in one batch (D1's limit per call is far higher; this only keeps a reply's size in bounds). */
const MAX_BATCH = 50;
/** Microtask hops before the queue goes. */
const HOPS = 32;

export function packReads(db: D1Database): D1Database {
	if (packed.has(db)) return db;
	let queue: Queued[] = [];
	let sending: Promise<unknown> = Promise.resolve();
	let due = false;

	const send = (list: Queued[]) => {
		if (list.length === 1) {
			const [q] = list;
			return q.statement.all().then(q.resolve, q.reject);
		}
		return db.batch(list.map((q) => q.statement)).then(
			(results) => list.forEach((q, i) => q.resolve(results[i])),
			// One bad statement fails them all: each on its own, for its own answer.
			() => Promise.all(list.map((q) => q.statement.all().then(q.resolve, q.reject))),
		);
	};
	const flush = () => {
		due = false;
		const list = queue;
		queue = [];
		const sent: Promise<unknown>[] = [];
		for (let i = 0; i < list.length; i += MAX_BATCH) sent.push(send(list.slice(i, i + MAX_BATCH)));
		sending = Promise.all([sending, ...sent]);
		return sending;
	};
	const enqueue = (statement: D1PreparedStatement) =>
		new Promise<D1Result<unknown>>((resolve, reject) => {
			queue.push({ statement, resolve, reject });
			if (!due) {
				due = true;
				// A few promise hops later: the views started together have issued their first reads by then.
				let hops = HOPS;
				const later = () => (!due ? undefined : --hops > 0 ? queueMicrotask(later) : void flush());
				queueMicrotask(later);
			}
		});
	/** Before anything that is not a queued read: the reads queued so far, answered. */
	const settled = () => (queue.length ? flush() : sending);

	const wrap = (statement: D1PreparedStatement, read: boolean): D1PreparedStatement => {
		const out = new Proxy(statement, {
			get(target, key) {
				if (key === 'bind') return (...values: unknown[]) => wrap(target.bind(...values), read);
				if (read && key === 'all') return () => enqueue(target);
				if (read && key === 'first')
					return async (column?: string) => {
						const row = ((await enqueue(target)).results[0] ?? null) as Record<string, unknown> | null;
						return column === undefined ? row : row ? (row[column] ?? null) : null;
					};
				const value = Reflect.get(target, key, target);
				if (typeof value !== 'function') return value;
				// `run`, `raw` (and reads' `run`): at once, after the queued reads.
				return async (...args: unknown[]) => {
					await settled().catch(() => {});
					return (value as (...a: unknown[]) => unknown).apply(target, args);
				};
			},
		});
		inner.set(out, statement);
		return out;
	};

	const out = new Proxy(db, {
		get(target, key) {
			if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), READ.test(sql));
			if (key === 'batch')
				return async (statements: D1PreparedStatement[]) => {
					await settled().catch(() => {});
					return target.batch(statements.map((s) => inner.get(s) ?? s));
				};
			const value = Reflect.get(target, key, target);
			if (typeof value !== 'function') return value;
			if (key !== 'exec' && key !== 'dump') return value.bind(target);
			return async (...args: unknown[]) => {
				await settled().catch(() => {});
				return (value as (...a: unknown[]) => unknown).apply(target, args);
			};
		},
	});
	packed.add(out);
	return out;
}
