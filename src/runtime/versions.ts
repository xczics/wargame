/**
 * Server versions (1.4.1, user 2026-10-19: "服务器升级时，先按之前的规则结算后，再按新规则运行。"): each version records,
 * the first time it serves, when it started and the rules in force with it (`engine_versions`). Requests then carry the
 * moment of the last upgrade and the rules before it (`EngineContext.upgrade`), and the owners of values that accrue
 * settle the time before it at those rules, lazily, the first time each one is touched.
 *
 * Versions from before this (1.4.0) recorded nothing: `rule-history.json` holds what they had for the rules that
 * changed since (patched over the rules of the first recording version, the GM's overrides included).
 */
import pkg from '../../package.json';
import type { ConfigSnapshot, FileStore } from '../kernel';
import history from './rule-history.json';

type Upgrade = { at: number; config: ConfigSnapshot };
type Row = { version: string; started_at: number; file: string };

/** Objects merged key by key (deep); anything else replaced. */
function patch(base: unknown, over: unknown): unknown {
	if (!over || typeof over !== 'object' || Array.isArray(over) || !base || typeof base !== 'object' || Array.isArray(base)) return over;
	const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const [k, v] of Object.entries(over)) out[k] = patch(out[k], v);
	return out;
}

/** The rules a version recorded before this one had, from the history (null: unknown). */
export function historical(version: string, now: ConfigSnapshot): ConfigSnapshot | null {
	const changed = (history as Record<string, Record<string, unknown>>)[version];
	if (!changed) return null;
	const out: Record<string, unknown> = { ...now };
	for (const [key, value] of Object.entries(changed)) if (key in out) out[key] = patch(out[key], value);
	return out as ConfigSnapshot;
}

// Per isolate: a version does not change while it runs (one small read when an isolate starts).
let known: Promise<Upgrade | null> | null = null;

const fileOf = (version: string) => `versions/${version}.json`;

/**
 * The last upgrade (null on a world that never had one), recording this version first if it is new. `values`: the
 * rules in force now (the snapshot a new version records: ~1.5 MB, so a file of the bucket, not a row). Without a
 * bucket nothing is recorded (no settling at older rules).
 */
export function upgradeOf(db: D1Database, files: FileStore | undefined, values: ConfigSnapshot, now: number): Promise<Upgrade | null> {
	if (!files) return Promise.resolve(null);
	known ??= (async () => {
		const latest = () => db.prepare('SELECT version, started_at, file FROM engine_versions ORDER BY started_at DESC LIMIT 2').all<Row>();
		let rows = (await latest()).results;
		if (rows[0]?.version !== pkg.version) {
			// Files first: a row only names what is there.
			await files.put(fileOf(pkg.version), JSON.stringify(values), { contentType: 'application/json' });
			const insert = db.prepare('INSERT OR IGNORE INTO engine_versions (version, started_at, file) VALUES (?, ?, ?)');
			const writes = [insert.bind(pkg.version, now, fileOf(pkg.version))];
			// The first version to record: the one before it is known from the history, if at all (from the start of time).
			const before = Object.keys(history).at(-1);
			const old = !rows.length && before && before !== pkg.version ? historical(before, values) : null;
			if (old) {
				await files.put(fileOf(before!), JSON.stringify(old), { contentType: 'application/json' });
				writes.push(insert.bind(before!, 0, fileOf(before!)));
			}
			await db.batch(writes);
			rows = (await latest()).results;
		}
		const [current, previous] = rows;
		if (!current || !previous) return null;
		const config = await files.get(previous.file);
		return config ? { at: current.started_at, config: JSON.parse(config) as ConfigSnapshot } : null;
	})().catch((err) => {
		known = null; // try again next request
		throw err;
	});
	return known;
}

/** Tests: forget what this isolate knew. */
export const forgetUpgrade = () => void (known = null);
