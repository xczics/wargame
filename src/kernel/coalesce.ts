/**
 * Fewer statements per commit: single-row INSERTs into the same table with the same SQL become multi-row
 * INSERTs. D1 counts every statement of a batch against the queries a Worker invocation may run (50 on the
 * free plan, 1,000 paid) and against the rows it bills, so a command that founds a hundred settlements
 * should not send a thousand statements.
 *
 * Only what keeps the meaning is merged: an INSERT joins an earlier one (and moves up to its place) only if
 * no statement touching its table came in between, so every table still sees its statements in order, and
 * rows inserted earlier still go in before the ones that depend on them. A statement the engine cannot read
 * (not made through `recording`) is left exactly where it is, and closes every open group.
 */

/** What a statement was made of, for statements prepared through `recording`. */
interface Recorded {
	sql: string;
	values: unknown[];
}

const recorded = new WeakMap<object, Recorded>();

/** A database whose prepared statements remember their SQL and bound values (for `coalesce`). */
export function recording(db: D1Database): D1Database {
	const wrap = (s: D1PreparedStatement, sql: string, values: unknown[]): D1PreparedStatement => {
		const w = new Proxy(s, {
			get(target, key) {
				if (key === 'bind') return (...v: unknown[]) => wrap(target.bind(...v), sql, v);
				const value = Reflect.get(target, key, target);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		recorded.set(w, { sql, values });
		return w;
	};
	return new Proxy(db, {
		get(target, key) {
			if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql, []);
			const value = Reflect.get(target, key, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

/** D1's limit on bound parameters per statement. */
const MAX_PARAMS = 100;
/** `INSERT [OR …] INTO t (cols) VALUES (?, …)` plus an optional ON CONFLICT clause: one row, mergeable. */
const SINGLE_INSERT =
	/^\s*(INSERT(?:\s+OR\s+\w+)?\s+INTO\s+(\w+)\s*\(([^)]*)\)\s*VALUES\s*)(\(\s*\?(?:\s*,\s*\?)*\s*\))(\s+ON\s+CONFLICT[\s\S]*)?\s*$/i;

/** The tables a statement's SQL names (for keeping each table's statements in order). */
const tablesOf = (sql: string) => new Set((sql.match(/\b[a-z][a-z0-9]*_[a-z0-9_]+\b/gi) ?? []).map((t) => t.toLowerCase()));

/** The statements to send, single-row INSERTs merged where that keeps the meaning (see above). */
export function coalesce(db: D1Database, statements: D1PreparedStatement[]): D1PreparedStatement[] {
	type Group = { head: string; tail: string; row: string; table: string; rows: unknown[][]; columns: number };
	const out: (D1PreparedStatement | Group)[] = [];
	/** Open groups by SQL; a statement touching a table closes that table's groups. */
	const open = new Map<string, Group>();
	const close = (tables: Set<string>) => {
		for (const [sql, g] of open) if (tables.has(g.table)) open.delete(sql);
	};
	for (const s of statements) {
		const r = recorded.get(s);
		const m = r && SINGLE_INSERT.exec(r.sql);
		if (!r || !m) {
			if (r) close(tablesOf(r.sql));
			else open.clear();
			out.push(s);
			continue;
		}
		const [, head, table, columns, row, tail = ''] = m;
		const count = columns.split(',').length;
		const group = open.get(r.sql);
		// Same SQL, nothing on its table since: one more row (as long as the parameters fit).
		if (group && (group.rows.length + 1) * count <= MAX_PARAMS && r.values.length === count) {
			group.rows.push(r.values);
			continue;
		}
		close(new Set([table.toLowerCase()]));
		if (r.values.length !== count) {
			out.push(s);
			continue;
		}
		const g: Group = { head, tail, row, table: table.toLowerCase(), rows: [r.values], columns: count };
		open.set(r.sql, g);
		out.push(g);
	}
	return out.map((x) => {
		if (!('rows' in x)) return x;
		if (x.rows.length === 1) return db.prepare(`${x.head}${x.row}${x.tail}`).bind(...x.rows[0]);
		return db.prepare(`${x.head}${x.rows.map(() => x.row).join(', ')}${x.tail}`).bind(...x.rows.flat());
	});
}
