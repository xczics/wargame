/**
 * A database that reads for real and writes nothing, for running a real command through the engine as it runs in
 * production without changing a row (`/api/_bench/real/…`).
 *
 * It sits under everything else (the engine's packing and recording wrap it), so it sees exactly the statements D1
 * would get. A statement that is not a SELECT is never sent as it is: in its place goes a no-op UPDATE with the same
 * bound values (the kernel's `noopWrite`: its WHERE is false), in the same position of the
 * same batch, so D1 still gets the call, the statement count and the parameters to carry, and the Worker still pays
 * for sending them; but the WHERE is false, nothing is touched and no trigger fires.
 */

import { noopWrite } from '../../kernel';

const READ = /^\s*SELECT\b/i;

interface Made {
	sql: string;
	values: unknown[];
	/** The binding's own statement (what D1's `batch` is given). */
	real: D1PreparedStatement;
}

export interface DryRun {
	db: D1Database;
	/** Writes replaced so far (statements, and how many of them went in batches). */
	replaced: { statements: number; batches: number };
}

/** Asked of a statement for what it was made of: the wrappers above (the engine's recording) pass it through. */
const MADE = Symbol('bench.made');
const madeOf = (s: D1PreparedStatement) => (s as unknown as Record<symbol, Made | undefined>)[MADE];

export function dryDatabase(raw: D1Database): DryRun {
	const replaced = { statements: 0, batches: 0 };
	const sendable = (s: D1PreparedStatement): D1PreparedStatement => {
		const m = madeOf(s);
		if (!m) throw new Error('bench: a statement not prepared through the dry database');
		if (READ.test(m.sql)) return m.real;
		replaced.statements++;
		return noopWrite(raw, m.values);
	};
	const wrap = (real: D1PreparedStatement, sql: string, values: unknown[]): D1PreparedStatement => {
		const m: Made = { sql, values, real };
		const out = new Proxy(real, {
			get(target, key) {
				if (key === MADE) return m;
				if (key === 'bind') return (...v: unknown[]) => wrap(target.bind(...v), sql, v);
				const value = Reflect.get(target, key, target);
				if (typeof value !== 'function') return value;
				// A write run on its own: its no-op instead.
				const run = READ.test(sql) ? target : sendable(out);
				return (...args: unknown[]) => (Reflect.get(run, key, run) as (...a: unknown[]) => unknown).apply(run, args);
			},
		});
		return out;
	};
	const db = new Proxy(raw, {
		get(target, key) {
			if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql), sql, []);
			if (key === 'batch')
				return (statements: D1PreparedStatement[]) => {
					const list = statements.map(sendable);
					if (statements.some((s) => !READ.test(madeOf(s)!.sql))) replaced.batches++;
					return target.batch(list);
				};
			if (key === 'exec' || key === 'dump') return () => Promise.reject(new Error(`bench: ${String(key)} is not allowed in a dry run`));
			const value = Reflect.get(target, key, target);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
	return { db, replaced };
}
