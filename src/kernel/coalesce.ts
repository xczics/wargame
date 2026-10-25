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

import { engineDb, statementOf } from './db';

/** A database whose prepared statements remember their SQL and bound values (for `coalesce`): the engine's (db.ts). */
export const recording = engineDb;
export { sqlOf } from './db';

/** D1's limit on bound parameters per statement. */
const MAX_PARAMS = 100;
/** The statements to send, single-row INSERTs merged where that keeps the meaning (see above). */
export function coalesce(db: D1Database, statements: D1PreparedStatement[]): D1PreparedStatement[] {
	type Group = { head: string; tail: string; row: string; table: string; rows: unknown[][]; columns: number };
	const out: (D1PreparedStatement | Group)[] = [];
	/** Open groups by SQL; a statement touching a table closes that table's groups. */
	const open = new Map<string, Group>();
	const close = (tables: ReadonlySet<string>) => {
		for (const [sql, g] of open) if (tables.has(g.table)) open.delete(sql);
	};
	for (const s of statements) {
		const r = statementOf(s);
		const m = r?.info.insert;
		if (!r || !m) {
			if (r) close(r.info.names);
			else open.clear();
			out.push(s);
			continue;
		}
		const { head, table, columns: count, row, tail } = m;
		const group = open.get(r.sql);
		// Same SQL, nothing on its table since: one more row (as long as the parameters fit).
		if (group && (group.rows.length + 1) * count <= MAX_PARAMS && r.values.length === count) {
			group.rows.push(r.values);
			continue;
		}
		close(new Set([table]));
		if (r.values.length !== count) {
			out.push(s);
			continue;
		}
		const g: Group = { head, tail, row, table, rows: [r.values], columns: count };
		open.set(r.sql, g);
		out.push(g);
	}
	return out.map((x) => {
		if (!('rows' in x)) return x;
		if (x.rows.length === 1) return db.prepare(`${x.head}${x.row}${x.tail}`).bind(...x.rows[0]);
		return db.prepare(`${x.head}${x.rows.map(() => x.row).join(', ')}${x.tail}`).bind(...x.rows.flat());
	});
}
