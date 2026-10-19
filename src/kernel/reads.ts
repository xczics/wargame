/**
 * Which tables a view's data came from, so a command invalidates only the views it touched (2026-10-19, user: "先做
 * '仅真正受影响的视图才重算'"). Before, a view's stamp held the player's lock version, which every command moves on: a
 * mail marked read made the whole City page be worked out again.
 *
 * - Every commit moves on a version per (locked player, table written): `player:<id>#<table>` rows of `engine_locks`
 *   (`bumpTables`).
 * - While a view is worked out, the tables of the statements it prepares are noted (`reading`, carried through awaits by
 *   AsyncLocalStorage); a memo notes its own, and every view using it gets them, whoever loaded it.
 * - `playerStamp` is then the versions of the tables the view read the last time (their codes ride in the stamp the
 *   client holds): unchanged unless a commit locking the player wrote one of them.
 *
 * The same commits move these on as moved the player's lock version before (those locking the player), so a view is
 * never left stale where it was not before; it is only no longer worked out again for commits that wrote none of its
 * tables. A write whose table cannot be told (`UNKNOWN`) counts for every view.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What one view (or memo) read: its own tables, codes of tables read for it earlier (a stored derived value read back:
 * `api.derived`), and the memos it used (filled in as they load).
 */
export interface Reads {
	tables: Set<string>;
	codes: Set<string>;
	uses: Set<Reads>;
}
export const newReads = (): Reads => ({ tables: new Set(), codes: new Set(), uses: new Set() });

/** The reads being noted now (a view's or a memo's). */
export const reading = new AsyncLocalStorage<Reads>();
/** The table codes `playerStamp` stamps with now: the view's last reads (checking a stamp) or this compute's. */
export const stamping = new AsyncLocalStorage<string[]>();

const READ = /\b(?:FROM|JOIN)\s+["`[]?([A-Za-z_]\w*)/gi;
const WRITE = /^\s*(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["`[]?([A-Za-z_]\w*)/i;
/** Stands for a write whose table is not known: every view depends on it. */
export const UNKNOWN = '?';
/** Tables the engine keeps for itself (locks, versions, stored derived values): not data a view shows. */
export const OWN = new Set(['engine_locks', 'engine_derived']);

const readCache = new Map<string, string[]>();
/** The tables a statement reads (cached by SQL: statements repeat). */
export function tablesRead(sql: string): string[] {
	let out = readCache.get(sql);
	if (!out) {
		out = [...new Set([...sql.matchAll(READ)].map((m) => m[1].toLowerCase()))].filter((t) => !OWN.has(t));
		if (readCache.size < 2000) readCache.set(sql, out);
	}
	return out;
}
/** The table a write statement writes, or `UNKNOWN`. */
export const tableWritten = (sql: string | undefined): string => (sql && WRITE.exec(sql)?.[1]?.toLowerCase()) || UNKNOWN;

/** Note a statement's tables in the reads being noted now (if any). */
export function noteRead(sql: string) {
	const reads = reading.getStore();
	if (reads) for (const t of tablesRead(sql)) reads.tables.add(t);
}

/** The codes of every table under `reads` (the memos it used included), sorted, `UNKNOWN`'s always among them. */
export function codesUnder(reads: Reads): string[] {
	const out = new Set<string>([codeOf(UNKNOWN)]);
	const seen = new Set<Reads>();
	const walk = (r: Reads) => {
		if (seen.has(r)) return;
		seen.add(r);
		for (const t of r.tables) out.add(codeOf(t));
		for (const c of r.codes) out.add(c);
		for (const u of r.uses) walk(u);
	};
	walk(reads);
	return [...out].sort();
}

/** A short code per table for stamps (4 base-36 characters; two tables sharing one only add up: still safe). */
const codes = new Map<string, string>();
export function codeOf(table: string): string {
	let c = codes.get(table);
	if (!c) {
		let h = 0x811c9dc5;
		for (let i = 0; i < table.length; i++) h = Math.imul(h ^ table.charCodeAt(i), 0x01000193);
		c = (h >>> 0).toString(36).padStart(4, '0').slice(-4);
		codes.set(table, c);
	}
	return c;
}

/** The entity of a player's table version (`engine_locks`), and the range holding all of a player's. */
export const tableEntity = (playerEntity: string, table: string) => `${playerEntity}#${table}`;
export const tableRange = (playerEntity: string) => [`${playerEntity}#`, `${playerEntity}$`] as const;

/** `T<codes>.<sum of their versions>`: what `playerStamp` puts in a stamp; the codes read back from a held one. */
export const tablesStamp = (list: string[], versions: ReadonlyMap<string, number>) =>
	`T${list.join('')}.${list.reduce((n, c) => n + (versions.get(c) ?? 0), 0)}`;
export function codesIn(stamp: string | undefined): string[] | null {
	const m = stamp && /(?:^|\|)T((?:[0-9a-z]{4})*)\.\d+(?:\||$)/.exec(stamp);
	return m ? (m[1].match(/.{4}/g) ?? []) : null;
}
