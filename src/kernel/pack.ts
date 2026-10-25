import { engineDb } from './db';

/** Reads packed into one round trip, statements that know their SQL, reads noted: the engine's database (db.ts). */
export const packReads = engineDb;

/** Most ids in one `IN (…)`: D1 binds at most 100 parameters a statement, and the rest of a query takes some. */
export const IN_MAX = 90;
/** `list` in slices of `size` (default `IN_MAX`): one `IN (…)` query each. */
export function chunks<T>(list: readonly T[], size = IN_MAX): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
	return out;
}

/**
 * A fast path's reads from several parts (listeners, requirements, options) in one record: each part's keys under
 * `prefix`, so its rows come back apart (`flatPart`) and every part's reads go to D1 in the same batch.
 */
export function prefixed<T>(prefix: string, reads: Record<string, T>): Record<string, T> {
	const out: Record<string, T> = {};
	for (const [k, v] of Object.entries(reads)) out[`${prefix}${k}`] = v;
	return out;
}
/** One part's rows of a fast path's (`prefixed`), under its own keys again. */
export function flatPart<T>(rows: Record<string, T>, prefix: string): Record<string, T> {
	const out: Record<string, T> = {};
	for (const [k, v] of Object.entries(rows)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
	return out;
}

/** A statement that writes nothing, binding `values` (a dry run's stand-in for a write: the same values sent, no change). */
export function noopWrite(db: D1Database, values: unknown[]): D1PreparedStatement {
	if (!values.length) return db.prepare('UPDATE engine_locks SET version = version WHERE 0');
	return db
		.prepare(`UPDATE engine_locks SET version = version WHERE 0 AND entity IN (${values.map(() => '?').join(', ')})`)
		.bind(...values);
}
