/**
 * Runs commands, views and reports against D1.
 *
 * A command is a unit of work: it reads the rows it needs (through plugin services),
 * queues writes, and the engine commits everything in ONE `db.batch()` — D1 batches
 * are transactions, so either every write lands or none does.
 *
 * Concurrency is optimistic. Every command locks `player:<id>` (plus anything it adds
 * with `api.lock`). Commit bumps each lock's version in the same batch; a trigger on
 * `engine_locks` aborts the batch if the version moved since we read it (someone else
 * committed first). The engine then re-runs the command on fresh data.
 */
import type { ClientState, ViewInstance } from '../shared/api';
import { coalesce, recording, sqlOf } from './coalesce';
import { resolveConfig } from './config';
import { packReads } from './pack';
import { GameError, PluginError } from './errors';
import type { Kernel } from './kernel';
import {
	codeOf,
	codesIn,
	codesUnder,
	newReads,
	noteRead,
	reading,
	stamping,
	tableEntity,
	tableRange,
	tablesStamp,
	tableWritten,
	UNKNOWN,
	type Reads,
} from './reads';
import type { EngineApi, EngineContext, MemoOptions, ReadApi, Report, View, ViewParams } from './types';

export type { ClientState };

const MAX_ATTEMPTS = 5;
const CONFLICT = 'version_conflict';

/** Convenience for tests / tools: a context with default config (plus optional overrides). */
export function engineContext(
	kernel: Kernel,
	playerId: string,
	now: number,
	overrides?: Record<string, unknown>,
	privileged = false,
): EngineContext {
	return { playerId, now, config: resolveConfig(kernel, overrides).values, privileged, gmViewer: privileged };
}

export const playerEntity = (playerId: string) => `player:${playerId}`;

/** Loaded values a committed command hands to the views of the same request (`MemoOptions.current`). */
export type Carried = ReadonlyMap<string, Promise<unknown>>;

/** What each memo read, by its promise (kept with it when a command hands it to the views: `Carried`). */
const readsOf = new WeakMap<Promise<unknown>, Reads>();
/** A memo was used by whatever is noting its reads now: its tables count for it too. */
const used = (p: Promise<unknown> | undefined) => {
	const r = p && readsOf.get(p);
	if (r) reading.getStore()?.uses.add(r);
	return p;
};

/** A derived value worked out or read back in this call (`api.derived`), and how far the command's writes were then. */
interface Derived {
	owner: string;
	salt: string;
	compute: () => Promise<unknown>;
	value: Promise<unknown>;
	/** Codes of the tables it rests on. */
	codes: string[];
	/** How many writes the command had queued when it was worked out or checked: later ones may have touched it. */
	at: number;
	/**
	 * Worked out here from what is committed (no write of this command touched its tables), with the sum of its tables'
	 * versions as read before: to be stored. A commit moving one of them on meanwhile leaves the stored row disagreeing
	 * with the versions, so never read back.
	 */
	store?: { sum: number };
}
/** The derived values of each api (stored by the commit, or after the views). */
const derivedIn = new WeakMap<ReadApi, Map<string, Derived>>();
/** The codes of the tables `writes` write (`UNKNOWN`'s for a statement the engine cannot read). */
const writtenCodes = (writes: readonly D1PreparedStatement[]) => new Set(writes.map((w) => codeOf(tableWritten(sqlOf(w)))));

/** A player's table versions by code (one range of `engine_locks`). */
const tableVersions = (api: ReadApi, playerId: string) =>
	api.memo(`engine:tables:${playerId}`, async () => {
		const [lo, hi] = tableRange(playerEntity(playerId));
		const { results } = await api.db
			.prepare('SELECT entity, version FROM engine_locks WHERE entity > ? AND entity < ?')
			.bind(lo, hi)
			.all<{ entity: string; version: number }>();
		const out = new Map<string, number>();
		for (const r of results) {
			const code = codeOf(r.entity.slice(lo.length));
			out.set(code, (out.get(code) ?? 0) + r.version);
		}
		return out;
	});
const sumOf = (codes: string[], versions: ReadonlyMap<string, number>) => codes.reduce((n, c) => n + (versions.get(c) ?? 0), 0);

function readApi(
	kernel: Kernel,
	raw: D1Database,
	ctx: EngineContext,
	carried?: Carried,
	keep?: Map<string, Promise<unknown>>,
	/** A command's queued writes (none for views): a derived value they touched is worked out again. */
	writes?: readonly D1PreparedStatement[],
	/** Codes of the tables commit hooks still to run will write (`beforeCommit` … `writes`): touched already. */
	pending?: () => ReadonlySet<string>,
): ReadApi {
	// Statements note their tables for the view (or memo) preparing them (reads.ts).
	const db = new Proxy(raw, {
		get(target, key) {
			if (key === 'prepare') return (sql: string) => (noteRead(sql), target.prepare(sql));
			const v = Reflect.get(target, key, target);
			return typeof v === 'function' ? v.bind(target) : v;
		},
	});
	const cache = new Map<string, Promise<unknown>>(carried ?? []);
	const fresh = new Set<string>();
	const derived = new Map<string, Derived>();
	const touched = (codes: string[], from: number) => {
		const later = pending?.();
		if (later?.size && codes.some((c) => later.has(c))) return true;
		if (!writes || writes.length <= from) return false;
		const written = writtenCodes(writes.slice(from));
		return codes.some((c) => written.has(c));
	};
	const { files, ...rest } = ctx;
	let before: Promise<EngineApi | null> | undefined;
	const api: ReadApi = {
		...rest,
		beforeUpgrade() {
			if (before === undefined) {
				const { upgrade, ...now } = ctx;
				// Rules this version added keep their current value (the older one had none).
				// No rules version: derived values are worked out there, never read back (they are for the rules of now).
				before = upgrade
					? upgrade
							.config()
							.then((config) =>
								dryRunApi(kernel, raw, { ...now, now: upgrade.at, config: { ...ctx.config, ...config }, rulesVersion: undefined }),
							)
					: Promise.resolve(null);
			}
			return before;
		},
		...(files ? { files: { get: (key: string) => files.get(key) } } : {}),
		db,
		services: kernel.services,
		memo<T>(key: string, load: () => Promise<T>, options?: MemoOptions): Promise<T> {
			if (!cache.has(key)) {
				const reads = newReads();
				// Filled from rows read just before (a list seeding each of its items' memos): those tables count for it.
				const parent = reading.getStore();
				if (parent) {
					for (const t of parent.tables) reads.tables.add(t);
					for (const u of parent.uses) reads.uses.add(u);
				}
				const p = reading.run(reads, load);
				readsOf.set(p, reads);
				cache.set(key, p);
			}
			if (options?.current) keep?.set(key, cache.get(key)!);
			return used(cache.get(key)) as Promise<T>;
		},
		peek: <T>(key: string) => used(cache.get(key)) as Promise<T> | undefined,
		version(entity) {
			const key = `engine:version:${entity}`;
			if (!cache.has(key))
				cache.set(
					key,
					db
						.prepare('SELECT version FROM engine_locks WHERE entity = ?')
						.bind(entity)
						.first<{ version: number }>()
						.then((r) => r?.version ?? 0),
				);
			return cache.get(key) as Promise<number>;
		},
		fresh: (entity) => void fresh.add(entity),
		isFresh: (entity) => fresh.has(entity),
		async derived<T>(key: string, { owner, salt = '' }: { owner: string | null; salt?: string }, compute: () => Promise<T>): Promise<T> {
			const rules = ctx.rulesVersion;
			if (!owner || rules === undefined) return compute();
			const caller = reading.getStore();
			const known = derived.get(key);
			if (known && known.owner === owner && known.salt === salt && !touched(known.codes, known.at)) {
				for (const c of known.codes) caller?.codes.add(c);
				return known.value as Promise<T>;
			}
			const entry: Derived = { owner, salt, compute, value: Promise.resolve(), codes: [], at: writes?.length ?? 0 };
			derived.set(key, entry);
			entry.value = (async () => {
				// All of the owner's at once (one statement for every settlement a page shows).
				const rows = await api.memo(`engine:derived:${owner}`, async () => {
					const { results } = await db
						.prepare('SELECT key, rules, salt, codes, sum, value FROM engine_derived WHERE owner = ?')
						.bind(owner)
						.all<{ key: string; rules: number; salt: string; codes: string; sum: number; value: string }>();
					return new Map(results.map((r) => [r.key, r]));
				});
				const row = rows.get(key);
				// Versions first: whatever is read after them is at least as new (a later commit only makes the row stale).
				const versions = await tableVersions(api, owner);
				if (row && row.rules === rules && row.salt === salt) {
					const codes = row.codes.match(/.{4}/g) ?? [];
					if (sumOf(codes, versions) === row.sum && !touched(codes, 0)) {
						entry.codes = codes;
						return JSON.parse(row.value) as T;
					}
				}
				const reads = newReads();
				const value = await reading.run(reads, compute);
				entry.codes = codesUnder(reads);
				// After this command's own writes to its tables it shows what is not committed yet: not stored.
				if (!touched(entry.codes, 0)) entry.store = { sum: sumOf(entry.codes, versions) };
				return value;
			})();
			const value = await entry.value;
			for (const c of entry.codes) caller?.codes.add(c);
			return value as T;
		},
	};
	derivedIn.set(api, derived);
	return api;
}

/**
 * A view stamp for what only commits touching the player (theirs, and others' that lock them) and the rules change:
 * one row read. Views add what else moves theirs (e.g. events falling due).
 */
/** `api.derived`, or worked out right away for a hand-made api without it (a rules view baking static data, tests). */
export const derive = <T>(api: ReadApi, key: string, options: { owner: string | null; salt?: string }, compute: () => Promise<T>) =>
	typeof api.derived === 'function' ? api.derived(key, options, compute) : compute();

export const playerStamp = async (api: ReadApi) => {
	// In a view's stamp: only the tables it read (reads.ts); elsewhere every commit touching the player.
	const list = stamping.getStore();
	if (!list) return `${await api.version(playerEntity(api.playerId))}|${api.rulesVersion ?? 0}`;
	return `${tablesStamp(list, await tableVersions(api, api.playerId))}|${api.rulesVersion ?? 0}`;
};

/** An `EngineApi` whose writes, commit hooks and locks do nothing (for views). */
function dryRunApi(kernel: Kernel, raw: D1Database, ctx: EngineContext, carried?: Carried): EngineApi {
	// Writes are dropped, but noted: what they touch is worked out again in memory (a building an event completes
	// changes the production numbers of the rest of the call), as in a command.
	const db = recording(raw);
	const writes: D1PreparedStatement[] = [];
	const base = readApi(kernel, db, ctx, carried, undefined, writes);
	const api: EngineApi = {
		...base,
		write: (...statements) => void writes.push(...statements),
		beforeCommit() {},
		async lock() {},
		touch() {},
		putFile() {},
	};
	derivedIn.set(api, derivedIn.get(base)!);
	return api;
}

/**
 * What an unchanged sync is checked against, per player: how many commits locked or touched them, the version of what
 * every player sees (`touch('world')`), and whether anything of theirs fell due (`ctx.views.wake`). Read with the
 * session (one D1 call: src/kernel/pack.ts); with the rules' version, the day, who looks and the deploy it makes the
 * key every stamp is confirmed under (`recordKey`).
 */
export interface PlayerRecord {
	playerId: string;
	version: number;
	world: number;
	due: boolean;
}

/** The entity of what every player sees (`EngineApi.touch`): its version is part of every player's record. */
export const WORLD = 'world';
const DAY = 86_400_000;

/**
 * A statement moving `entity`'s version on (`EngineApi.touch` in a command), for a write made outside any command
 * that changes what players see: `WORLD` for all of them (the GM's mail to everyone), in the same batch as the write.
 */
export const bumpVersion = (db: D1Database, entity: string) =>
	db
		.prepare('INSERT INTO engine_locks (entity, version) VALUES (?, 1) ON CONFLICT (entity) DO UPDATE SET version = version + 1')
		.bind(entity);

/** The player's record: its statements all issued at once (one batch, with whatever else is read now). */
export function readRecord(kernel: Kernel, db: D1Database, playerId: string, now: number): Promise<PlayerRecord> {
	const versions = db
		.prepare('SELECT entity, version FROM engine_locks WHERE entity IN (?, ?)')
		.bind(playerEntity(playerId), WORLD)
		.all<{ entity: string; version: number }>();
	const wakes = kernel.wakes.map((check) => check(db, playerId, now).first());
	return Promise.all([versions, Promise.all(wakes)]).then(([{ results }, due]) => {
		const of = (entity: string) => results.find((r) => r.entity === entity)?.version ?? 0;
		return { playerId, version: of(playerEntity(playerId)), world: of(WORLD), due: due.some((r) => r !== null) };
	});
}

/**
 * The key a view's stamp is confirmed under (its prefix, before `~`): while it stands and nothing is due, a quiet view
 * is unchanged (`View.quiet`). Besides the record: the rules, the day (UTC: what resets daily), the GM's eyes, the
 * deploy (`kernel.build`) and the player's id in short (a stamp held by someone else is not theirs).
 */
export const recordKey = (kernel: Kernel, ctx: EngineContext, r: PlayerRecord) =>
	`${r.version}.${r.world}.${ctx.rulesVersion ?? 0}.${Math.floor(ctx.now / DAY)}.${ctx.gmViewer ? 'g' : ''}${codeOf(kernel.build)}.${r.playerId.slice(0, 6)}`;

/** A stamp as the view's own `stamp` made it, without the key it was confirmed under. */
const ownPart = (stamp: string) => {
	const i = stamp.indexOf('~');
	return i < 0 ? stamp : stamp.slice(i + 1);
};
const isQuiet = (v: View, p: ViewParams) => (typeof v.quiet === 'function' ? v.quiet(p) : !!v.quiet);

/**
 * Current state for the acting player: the requested views (all by default), and `instances`: views computed
 * again with their own parameters on top of `params` (e.g. the forms of each form area the client shows), so
 * one request answers for the whole screen. Writes no game state (only derived values it worked out: `api.derived`).
 *
 * `record`: the player's (`readRecord`), read with the session, or `'read'` to read it with the views' first reads.
 * Stamps then carry the key they hold under (`recordKey`); with the record read before, unchanged and nothing due,
 * quiet views held under it are left out without a look (an unchanged sync: nothing more read at all).
 */
export async function computeViews(
	kernel: Kernel,
	db: D1Database,
	ctx: EngineContext,
	ids?: string[],
	params: ViewParams = {},
	instances: ViewInstance[] = [],
	carried?: Carried,
	/** What the client holds of views with a `stamp`: unchanged ones are left out (it keeps them). */
	held: Record<string, string> = {},
	record?: Promise<PlayerRecord> | 'read',
): Promise<ClientState> {
	// One shared api: views reuse each other's loaded rows through `memo` (and those a command just kept current).
	db = packReads(db);
	// Issued before anything else here (first in the batch): what the views read is at least as new.
	const recorded = record === 'read' ? readRecord(kernel, db, ctx.playerId, ctx.now) : record;
	recorded?.catch(() => {});
	const before = record && record !== 'read' ? await record.catch(() => null) : null;
	const still = before && before.playerId === ctx.playerId && !before.due ? `${recordKey(kernel, ctx, before)}~` : null;
	const api = dryRunApi(kernel, db, ctx, carried);
	const wanted = ids ? kernel.views.filter((v) => ids.includes(v.id)) : kernel.views;
	const byId = new Map(kernel.views.map((v) => [v.id, v]));
	const stamps: Record<string, string> = {};
	const instanceStamps: Record<string, string> = {};
	/**
	 * One view under `p`: left out when the stamp held is still its stamp (the client keeps what it has), else worked out
	 * with its new stamp. A stamp holds only under the same parameters (another settlement, another hero picked): they
	 * are part of it, so a view's own stamp needs to say nothing about them.
	 */
	const one = async (v: View, p: ViewParams, held?: string): Promise<{ value?: unknown; computed: boolean; stamp?: string }> => {
		const quiet = isQuiet(v, p);
		const stamp = v.stamp ?? (quiet ? playerStamp : undefined);
		const under = JSON.stringify(Object.entries(p).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
		const own = held === undefined ? undefined : ownPart(held);
		// Confirmed under the record as it still is, under these parameters: unchanged, nothing to look at.
		if (stamp && quiet && still && held?.startsWith(still) && own!.endsWith(`|${under}`)) return { computed: false, stamp: own };
		// Stamped by its tables only (no stamp of its own): that holds only while nothing of the player's is due.
		if (stamp && own !== undefined && (v.stamp || still)) {
			// Under the tables it read the last time (their codes are in the stamp held).
			const now = `${await stamping.run(codesIn(own) ?? [], () => stamp(api, p))}|${under}`;
			if (own === now) return { computed: false, stamp: now };
		}
		const reads = newReads();
		const value = await reading.run(reads, () => v.compute(api, p));
		return {
			value,
			computed: true,
			...(stamp ? { stamp: `${await stamping.run(codesUnder(reads), () => stamp(api, p))}|${under}` } : {}),
		};
	};
	const [entries, extra] = await Promise.all([
		Promise.all(
			wanted.map(async (v) => {
				const r = await one(v, params, held[v.id]);
				if (r.stamp) stamps[v.id] = r.stamp;
				return r.computed ? ([v.id, r.value] as const) : null;
			}),
		),
		Promise.all(
			// Instances too: each with the stamp the client holds for it (forms areas, map windows are asked every sync).
			instances.flatMap((i) => {
				const v = byId.get(i.view);
				if (!v) return [];
				return [
					(async () => {
						const r = await one(v, { ...params, ...i.params }, i.stamp);
						if (r.stamp) instanceStamps[i.key] = r.stamp;
						return r.computed ? ([i.key, r.value] as const) : null;
					})(),
				];
			}),
		),
	]);
	// Derived values worked out from what is committed: stored for the next call (the engine's own cache rows, not
	// game state; a failure only means working them out again).
	const rows = await storeDerived(db, derivedIn.get(api)!, ctx.rulesVersion);
	if (rows.length) await db.batch(rows).catch((err) => console.error('Storing derived values failed', err));
	// Every stamp confirmed under the record (read before anything else here: the views are at least as new).
	const after = recorded ? await recorded.catch(() => null) : null;
	if (after && after.playerId === ctx.playerId) {
		const key = recordKey(kernel, ctx, after);
		for (const list of [stamps, instanceStamps]) for (const k of Object.keys(list)) list[k] = `${key}~${list[k]}`;
	}
	return {
		now: ctx.now,
		views: Object.fromEntries(entries.filter((e) => e !== null)),
		...(extra.some((e) => e !== null) ? { instances: Object.fromEntries(extra.filter((e) => e !== null)) } : {}),
		...(Object.keys(stamps).length ? { stamps } : {}),
		...(Object.keys(instanceStamps).length ? { instanceStamps } : {}),
	};
}

export async function runReport(kernel: Kernel, db: D1Database, ctx: EngineContext, id: string, params: unknown) {
	const report: Report | undefined = kernel.reports.get(id);
	if (!report) throw new GameError('unknown_report', 'Unknown report "{0}"', 404, 'kernel', { 0: id });
	return report.run(readApi(kernel, db, ctx), params);
}

async function attempt(
	kernel: Kernel,
	rawDb: D1Database,
	ctx: EngineContext,
	execute: (api: EngineApi) => Promise<void>,
	keep: Map<string, Promise<unknown>>,
): Promise<void> {
	// Statements remember their SQL, so the commit can merge single-row inserts (coalesce.ts).
	const db = recording(rawDb);
	const locks = new Map<string, number>();
	const touched = new Set<string>();
	const writes: D1PreparedStatement[] = [];
	const files: Parameters<EngineApi['putFile']>[] = [];
	const flushers = new Map<string, () => void | Promise<void>>();
	const lastFlushers = new Map<string, () => void | Promise<void>>();
	// What the hooks not run yet will write: their changes are in memory already (`Derived` read back would be stale).
	const ran = new Set<string>();
	const willWrite = new Map<string, string[]>();
	const pending = () => {
		const out = new Set<string>();
		for (const [key, codes] of willWrite) if (!ran.has(key)) for (const c of codes) out.add(c);
		return out;
	};

	const base = readApi(kernel, db, ctx, undefined, keep, writes, pending);
	const api: EngineApi = {
		...base,
		write: (...statements) => void writes.push(...statements),
		beforeCommit(key, fn, options) {
			const list = options?.last ? lastFlushers : flushers;
			if (flushers.has(key) || lastFlushers.has(key)) return;
			list.set(key, fn);
			willWrite.set(key, (options?.writes ?? [UNKNOWN]).map(codeOf));
		},
		async lock(entity) {
			if (locks.has(entity)) return;
			const row = await db.prepare('SELECT version FROM engine_locks WHERE entity = ?').bind(entity).first<{ version: number }>();
			locks.set(entity, row?.version ?? 0);
		},
		touch: (entity) => void touched.add(entity),
		putFile(...file) {
			if (!ctx.files) throw new PluginError('No file storage here (the FILES bucket is not bound)');
			files.push(file);
		},
	};

	// The player's lock version is read with the command's first reads (one batch, in that order: src/kernel/pack.ts),
	// not on its own before them; it is still read before any of them, which is all the optimistic lock needs.
	const locked = api.lock(playerEntity(ctx.playerId));
	locked.catch(() => {});
	await execute(api);
	await locked;
	// Flushers may queue more writes (a Map iterates entries added during iteration too); `last` ones after them all.
	const flush = async (list: Map<string, () => void | Promise<void>>) => {
		for (const [key, fn] of list) if (!ran.has(key)) (ran.add(key), await fn());
	};
	await flush(flushers);
	await flush(lastFlushers);
	await flush(flushers); // any a last one added
	// Files first: whatever the commit points at is there by then (a failed commit leaves them unreferenced).
	await Promise.all(files.map((f) => ctx.files!.put(...f)));
	if (writes.length === 0) return;

	const bumps = [...locks].map(([entity, version]) =>
		db
			.prepare('INSERT INTO engine_locks (entity, version) VALUES (?, ?) ON CONFLICT (entity) DO UPDATE SET version = excluded.version')
			.bind(entity, version + 1),
	);
	// Touched, not locked: moved on whatever they are at (a command of theirs meanwhile is retried, as by a lock).
	const others = [...touched].filter((e) => !locks.has(e));
	for (const entity of others) bumps.push(bumpVersion(db, entity));
	const stored = await storeDerived(db, derivedIn.get(base)!, ctx.rulesVersion, writes);
	await db.batch([...bumps, ...bumpTables(db, [...locks.keys(), ...others], writes), ...coalesce(db, writes), ...stored]);
}

/** Rows for the derived values worked out from what is committed (`Derived.store`), each once. */
async function storeDerived(
	db: D1Database,
	derived: Map<string, Derived>,
	rules: number | undefined,
	writes: readonly D1PreparedStatement[] = [],
): Promise<D1PreparedStatement[]> {
	const out: D1PreparedStatement[] = [];
	if (rules === undefined) return out;
	// Written by this commit: stale as soon as it lands (the views after it store it anew).
	const written = writtenCodes(writes);
	for (const [key, d] of derived) {
		const value = await d.value;
		if (!d.store || d.codes.some((c) => written.has(c))) continue;
		out.push(
			db
				.prepare(
					`INSERT INTO engine_derived (key, owner, rules, salt, codes, sum, value) VALUES (?, ?, ?, ?, ?, ?, ?)
					 ON CONFLICT (key) DO UPDATE SET owner = excluded.owner, rules = excluded.rules, salt = excluded.salt, codes = excluded.codes,
					   sum = excluded.sum, value = excluded.value`,
				)
				.bind(key, d.owner, rules, d.salt, d.codes.join(''), d.store.sum, JSON.stringify(value)),
		);
		delete d.store;
	}
	return out;
}

/**
 * Every locked player's version of every table written (reads.ts): a view reading none of them keeps its stamp. Few
 * statements (90 entities each, D1's 100 parameters).
 */
function bumpTables(db: D1Database, locked: string[], writes: D1PreparedStatement[]): D1PreparedStatement[] {
	const tables = new Set(writes.map((w) => tableWritten(sqlOf(w))));
	const entities = locked
		.filter((e) => e.startsWith('player:') && !e.includes('#'))
		.flatMap((p) => [...tables].map((t) => tableEntity(p, t)));
	const out: D1PreparedStatement[] = [];
	for (let i = 0; i < entities.length; i += 90) {
		const chunk = entities.slice(i, i + 90);
		out.push(
			db
				.prepare(
					`INSERT INTO engine_locks (entity, version) VALUES ${chunk.map(() => '(?, 1)').join(', ')} ON CONFLICT (entity) DO UPDATE SET version = version + 1`,
				)
				.bind(...chunk),
		);
	}
	return out;
}

/**
 * Parse and run one command, committing its writes atomically. Retries on lock conflicts;
 * throws `GameError` for rejected commands (nothing is written in that case).
 */
export async function executeCommand(
	kernel: Kernel,
	db: D1Database,
	ctx: EngineContext,
	type: string,
	rawPayload: unknown,
): Promise<{ carried: Carried }> {
	const command = kernel.commands.get(type);
	if (!command || (command.privileged && !ctx.privileged)) {
		// Privileged commands are indistinguishable from unknown ones to regular players.
		throw new GameError('unknown_command', 'Unknown command "{0}"', 404, 'kernel', { 0: type });
	}
	const payload = command.parse(rawPayload);
	db = packReads(db);
	for (let i = 1; ; i++) {
		// What the successful attempt kept current, for the views of the same request (`computeViews(…, carried)`).
		const keep = new Map<string, Promise<unknown>>();
		try {
			await attempt(kernel, db, ctx, (api) => command.execute(api, payload), keep);
			kernel.hooks.emit('engine:command', { playerId: ctx.playerId, type, payload });
			return { carried: keep };
		} catch (err) {
			const conflict = err instanceof Error && err.message.includes(CONFLICT);
			if (!conflict) throw err;
			if (i >= MAX_ATTEMPTS) throw new GameError('busy', 'Too many simultaneous changes, please retry', 409);
		}
	}
}
