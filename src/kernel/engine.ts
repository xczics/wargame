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
import { coalesce } from './coalesce';
import { engineDb, statementOf } from './db';
import { resolveConfig } from './config';
import { chunks, packReads } from './pack';
import { GameError, PluginError } from './errors';
import type { Kernel } from './kernel';
import {
	codeOf,
	codesIn,
	codesUnder,
	inherit,
	newReads,
	reading,
	stamping,
	tableEntity,
	tableRange,
	tablesStamp,
	UNKNOWN,
	type Reads,
} from './reads';
import type {
	DerivedOptions,
	EngineApi,
	EngineContext,
	FlatCommand,
	FlatContext,
	MemoOptions,
	ReadApi,
	Report,
	View,
	ViewParams,
} from './types';

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
/** What a command's commit moved on: the player's lock version from and to, and the codes of the tables it wrote. */
export interface Committed {
	before: number;
	after: number;
	written: ReadonlySet<string>;
}

/** What each memo read, by its promise (kept with it when a command hands it to the views: `Carried`). */
const readsOf = new WeakMap<Promise<unknown>, Reads>();
/** A memo was used by whatever is noting its reads now: its tables count for it too. */
const used = (p: Promise<unknown> | undefined) => {
	const r = p && readsOf.get(p);
	const into = r && reading.getStore();
	// (\`addUse\` inline: every memo use of a request comes through here.)
	if (into && !into.uses.has(r)) {
		into.uses.add(r);
		into.useList.push(r);
	}
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
const writtenCodes = (writes: readonly D1PreparedStatement[]) => new Set(writes.map((w) => codeOf(writtenBy(w))));
/** The table a write writes, as its statement says (worked out once per SQL text, db.ts); `UNKNOWN` if it cannot tell. */
const writtenBy = (w: D1PreparedStatement) => statementOf(w)?.info.written ?? UNKNOWN;

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
type DerivedRow = { key: string; rules: number; salt: string; codes: string; sum: number; value: string };
/** Derived values asked for but not read yet, by call (its database) and owner: read together on the next tick. */
type Asked = { resolve: (row: DerivedRow | undefined) => void; reject: (err: unknown) => void };
const derivedAsked = new WeakMap<D1Database, Map<string, Map<string, Asked>>>();
/** All of an owner's stored derived values (a command's preload: one round trip for its reads one after another). */
const derivedRows = (api: ReadApi, owner: string) =>
	api.memo(`engine:derived:${owner}`, async () => {
		const { results } = await api.db
			.prepare('SELECT key, rules, salt, codes, sum, value FROM engine_derived WHERE owner = ?')
			.bind(owner)
			.all<DerivedRow>();
		return new Map(results.map((r) => [r.key, r]));
	});
/**
 * A stored derived value: from the owner's all when this call has them (a command), else those asked for in the same
 * tick read in one statement (`key IN (…)`, 90 a statement), only those (2026-10-24: views read all of the owner's
 * each time, dozens for a player of many settlements).
 */
const derivedRow = (api: ReadApi, owner: string, key: string) =>
	api.peek<Map<string, DerivedRow>>(`engine:derived:${owner}`)?.then((all) => all.get(key)) ??
	api.memo(
		`engine:derived:${owner}:${key}`,
		() =>
			new Promise<DerivedRow | undefined>((resolve, reject) => {
				let byOwner = derivedAsked.get(api.db);
				if (!byOwner) derivedAsked.set(api.db, (byOwner = new Map()));
				const asked = byOwner.get(owner);
				if (asked) return void asked.set(key, { resolve, reject });
				byOwner.set(owner, new Map([[key, { resolve, reject }]]));
				queueMicrotask(() => {
					const keys = byOwner.get(owner)!;
					byOwner.delete(owner);
					const list = [...keys.keys()];
					const reads: Promise<DerivedRow[]>[] = [];
					for (const chunk of chunks(list)) {
						reads.push(
							api.db
								.prepare(
									`SELECT key, rules, salt, codes, sum, value FROM engine_derived WHERE owner = ? AND key IN (${chunk.map(() => '?').join(', ')})`,
								)
								.bind(owner, ...chunk)
								.all<DerivedRow>()
								.then((r) => r.results),
						);
					}
					Promise.all(reads).then(
						(all) => {
							const found = new Map(all.flat().map((r) => [r.key, r]));
							for (const [k, a] of keys) a.resolve(found.get(k));
						},
						(err) => keys.forEach((a) => a.reject(err)),
					);
				});
			}),
	);
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
	// Statements note their tables for the view (or memo) preparing them (reads.ts): the engine's database does (db.ts).
	const db = engineDb(raw);
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
				if (parent) inherit(reads, parent);
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
		async derived<T>(key: string, { owner, salt = '', ignore }: DerivedOptions, compute: () => Promise<T>): Promise<T> {
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
				const row = await derivedRow(api, owner, key);
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
				const skip = ignore?.length ? new Set(ignore.map(codeOf)) : null;
				entry.codes = skip ? codesUnder(reads).filter((c) => !skip.has(c)) : codesUnder(reads);
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
export const derive = <T>(api: ReadApi, key: string, options: DerivedOptions, compute: () => Promise<T>) =>
	typeof api.derived === 'function' ? api.derived(key, options, compute) : compute();

/**
 * A kind of derived value named once (key prefix, shape version) for every path that stores or asks for it: the
 * regular one (`salt(due)`), a command's fast path and a flat view (`wanted(id)`: nothing due). The salt is
 * `<shape>|<the rest>`: change what is stored and bump `shape` here, and every path follows (2026-10-24: a fast path
 * kept the old salt and read rows of the old shape back as fresh).
 */
export function derivedKind(prefix: string, shape: number) {
	return {
		key: (id: string) => `${prefix}:${id}`,
		salt: (rest: string | number = 0) => `${shape}|${rest}`,
		wanted: (id: string) => ({ key: `${prefix}:${id}`, salt: `${shape}|0` }),
		/** Every one of the player's of this kind that is fresh (a fast path's `{ prefix }`): for ids known from its rows. */
		all: () => ({ prefix: `${prefix}:`, salt: `${shape}|0` }),
	};
}

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
	const db = engineDb(raw);
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
/** The parameters a stamp holds under (its last part). */
const paramsKey = (p: ViewParams) => JSON.stringify(Object.entries(p).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const isQuiet = (v: View, p: ViewParams) => (typeof v.quiet === 'function' ? v.quiet(p) : !!v.quiet);

/** The tables a flat view's reads read (`FlatView.tables` left out): from their SQL, once per view and set of reads. */
const flatTableCache = new Map<string, string[]>();
function flatTables(v: View, reads: Record<string, D1PreparedStatement>): string[] {
	const key = `${v.id}|${Object.keys(reads).sort().join(',')}`;
	let out = flatTableCache.get(key);
	if (!out) {
		out = [
			...new Set(
				Object.entries(reads).flatMap(([name, s]) => {
					const st = statementOf(s);
					if (!st) throw new PluginError(`Flat view "${v.id}": read "${name}" was not prepared on ctx.db`);
					return st.info.reads;
				}),
			),
		].sort();
		flatTableCache.set(key, out);
	}
	return out;
}

/**
 * The flat views' answers (`View.flat`), by id, each `undefined` when its regular compute must answer: their reads in
 * one batch (issued at once, with whatever else goes out now), with the player's table versions and the derived values
 * they ask for; nothing of the engine's bookkeeping (memos, reads noted). Only while nothing of the player's is due
 * (`clear`): they work no events out.
 */
function flatViews(
	kernel: Kernel,
	db: D1Database,
	ctx: EngineContext,
	views: View[],
	params: ViewParams,
	clear: () => Promise<boolean>,
): Map<string, Promise<{ value: unknown; stamp: string } | undefined>> {
	const out = new Map<string, Promise<{ value: unknown; stamp: string } | undefined>>();
	if (!views.length) return out;
	const rules = ctx.rulesVersion ?? 0;
	const fctx: FlatContext = { playerId: ctx.playerId, now: ctx.now, config: ctx.config, rulesVersion: rules, db };
	const [lo, hi] = tableRange(playerEntity(ctx.playerId));
	const versions = db
		.prepare('SELECT entity, version FROM engine_locks WHERE entity > ? AND entity < ?')
		.bind(lo, hi)
		.all<{ entity: string; version: number }>();
	const asked = views.map((v) => {
		const reads = v.flat!.reads(fctx, params);
		return { v, derived: v.flat!.derived?.(fctx, params) ?? [], reads, tables: v.flat!.tables ?? flatTables(v, reads) };
	});
	const keys = [...new Set(asked.flatMap((a) => a.derived.map((d) => d.key)))];
	const stored = keys.length
		? db
				.prepare(
					`SELECT key, rules, salt, codes, sum, value FROM engine_derived WHERE owner = ? AND key IN (${keys.map(() => '?').join(', ')})`,
				)
				.bind(ctx.playerId, ...keys)
				.all<{ key: string; rules: number; salt: string; codes: string; sum: number; value: string }>()
		: null;
	const rows = asked.map((a) => Object.entries(a.reads).map(([name, st]) => st.all().then((r) => [name, r.results] as const)));
	const shared = Promise.all([clear(), versions, stored]).then(([ok, v, d]) => {
		if (!ok) return null;
		const byCode = new Map<string, number>();
		for (const r of v.results) {
			const code = codeOf(r.entity.slice(lo.length));
			byCode.set(code, (byCode.get(code) ?? 0) + r.version);
		}
		return { byCode, derived: new Map((d?.results ?? []).map((r) => [r.key, r])) };
	});
	shared.catch(() => {});
	asked.forEach((a, i) => {
		const answer = Promise.all([shared, Promise.all(rows[i])]).then(([s, read]) => {
			if (!s) return undefined;
			const derived: Record<string, unknown> = {};
			for (const w of a.derived) {
				const row = s.derived.get(w.key);
				if (!row || row.rules !== rules || row.salt !== (w.salt ?? '') || sumOf(row.codes.match(/.{4}/g) ?? [], s.byCode) !== row.sum)
					return undefined;
				derived[w.key] = JSON.parse(row.value);
			}
			const value = a.v.flat!.build({ ...fctx, payload: params, rows: Object.fromEntries(read), derived });
			if (value === undefined) return undefined;
			// With the derived values' tables: what a command could change them by (`computeViews`'s `committed`).
			const codes = [
				...new Set([
					codeOf(UNKNOWN),
					...a.tables.map(codeOf),
					...a.derived.flatMap((w) => s.derived.get(w.key)!.codes.match(/.{4}/g) ?? []),
				]),
			].sort();
			// The derived values' own versions too: one worked out again (what it read changed) changes what it says.
			const versions = a.derived.map((w) => s.derived.get(w.key)!.sum).join(',');
			return { value, stamp: `${tablesStamp(codes, s.byCode)}|${rules}${versions ? `|d${versions}` : ''}` };
		});
		answer.catch(() => {});
		out.set(
			a.v.id,
			answer.catch(() => undefined),
		);
	});
	return out;
}

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
	/** The command just committed (with `record` `'read'`): stamps held from right before it need no look unless it wrote their tables. */
	committed?: Committed,
): Promise<ClientState> {
	// One shared api: views reuse each other's loaded rows through `memo` (and those a command just kept current).
	db = packReads(db);
	// Issued before anything else here (first in the batch): what the views read is at least as new.
	const recorded = record === 'read' ? readRecord(kernel, db, ctx.playerId, ctx.now) : record;
	recorded?.catch(() => {});
	const before = record && record !== 'read' ? await record.catch(() => null) : null;
	const still = before && before.playerId === ctx.playerId && !before.due ? `${recordKey(kernel, ctx, before)}~` : null;
	// Without a record read before (after a command): the one read first here tells whether anything is due; nothing
	// due, stamps by tables hold as well (2026-10-24: every command's answer sent such views again, unchanged).
	const nothingDue = still
		? Promise.resolve(true)
		: recorded
			? recorded.then(
					(r) => !!r && r.playerId === ctx.playerId && !r.due,
					() => false,
				)
			: Promise.resolve(false);
	// After a command, a stamp confirmed right before it (under the key it moved the record on from) still holds when the
	// command wrote none of its tables, nothing is due and nothing else committed for the player meanwhile (2026-10-24:
	// reading a mail had every view of the page check its stamp again). Only stamps moving with their tables alone
	// (`View.stampByTables`; a flat view's carry its derived values' tables).
	const sinceKey =
		committed && recorded
			? recorded.then(
					(r) =>
						// (Still at `before`: nothing landed at all, e.g. the bench's dry runs.)
						r.playerId === ctx.playerId && !r.due && (r.version === committed.after || r.version === committed.before)
							? `${recordKey(kernel, ctx, { ...r, version: committed.before })}~`
							: null,
					() => null,
				)
			: Promise.resolve(null);
	const untouched = (v: View, p: ViewParams, held: string | undefined) => {
		if (!committed || !held || (v.stamp && v.stamp !== playerStamp && !v.stampByTables) || !isQuiet(v, p)) return false;
		const own = ownPart(held);
		const codes = codesIn(own);
		return !!codes && own.endsWith(`|${paramsKey(p)}`) && !codes.some((c) => committed.written.has(c));
	};
	const api = dryRunApi(kernel, db, ctx, carried);
	const wanted = ids ? kernel.views.filter((v) => ids.includes(v.id)) : kernel.views;
	// Flat views (`View.flat`): their reads go out now, with the views' first ones, in one batch.
	const flat = flatViews(
		kernel,
		db,
		ctx,
		ctx.noFlat
			? []
			: wanted.filter(
					(v) => v.flat && !v.stamp && isQuiet(v, params) && !(still && held[v.id]?.startsWith(still)) && !untouched(v, params, held[v.id]),
				),
		params,
		// (Only asked with flat views to answer: nothing more read otherwise.)
		() =>
			still || recorded
				? nothingDue
				: readRecord(kernel, db, ctx.playerId, ctx.now).then(
						(r) => !r.due,
						() => false,
					),
	);
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
		const under = paramsKey(p);
		const own = held === undefined ? undefined : ownPart(held);
		// Confirmed under the record as it still is, under these parameters: unchanged, nothing to look at.
		if (stamp && quiet && still && held?.startsWith(still) && own!.endsWith(`|${under}`)) return { computed: false, stamp: own };
		if (untouched(v, p, held)) {
			const since = await sinceKey;
			if (since && held!.startsWith(since)) return { computed: false, stamp: own };
		}
		// Its flat form, when it could answer: the rows as read, stamped by its tables.
		const f = v.flat && params === p ? await flat.get(v.id) : undefined;
		if (f) {
			const now = `${f.stamp}|${under}`;
			return own === now ? { computed: false, stamp: now } : { value: f.value, computed: true, stamp: now };
		}
		// Stamped by its tables only (no stamp of its own): that holds only while nothing of the player's is due.
		if (stamp && own !== undefined && (v.stamp || (await nothingDue))) {
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
	preload?: (api: EngineApi) => unknown,
): Promise<Committed> {
	// Statements remember their SQL, so the commit can merge single-row inserts (coalesce.ts).
	const db = engineDb(rawDb);
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
	if (preload) startPreload(api, ctx, preload);
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
	const before = locks.get(playerEntity(ctx.playerId))!;
	if (writes.length === 0) return { before, after: before, written: new Set() };

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
	return { before, after: before + 1, written: writtenCodes(writes) };
}

/**
 * A command's `preload`: its reads started now, in the batch with the lock (src/kernel/pack.ts), with the player's stored
 * derived values and table versions (`api.derived` reads them first thing for any of the player's holders). Not awaited:
 * `execute` finds the memos filled, or on their way; whatever fails here fails again there, where it counts.
 */
function startPreload(api: EngineApi, ctx: EngineContext, preload: (api: EngineApi) => unknown) {
	const quiet = (p: unknown) => void (p instanceof Promise && p.catch(() => {}));
	if (ctx.rulesVersion !== undefined) {
		quiet(derivedRows(api, ctx.playerId));
		quiet(tableVersions(api, ctx.playerId));
	}
	try {
		quiet(preload(api));
	} catch {
		// Left for `execute`.
	}
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
	const tables = new Set(writes.map(writtenBy));
	const entities = locked
		.filter((e) => e.startsWith('player:') && !e.includes('#'))
		.flatMap((p) => [...tables].map((t) => tableEntity(p, t)));
	const out: D1PreparedStatement[] = [];
	for (const chunk of chunks(entities)) {
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
 * A command's fast path (`Command.flat`, docs/development.md §2.3 "快速通道"): its reads in one batch with the player's
 * lock version, table versions and the derived values it asked for; its pure work; its writes committed like
 * `execute`'s (the lock moved on, the tables' versions bumped, inserts merged). False: the regular path runs instead
 * (a derived value stale or missing, the command declining, a conflict — retried there).
 */
async function runFlat<P>(rawDb: D1Database, ctx: EngineContext, flat: FlatCommand<P>, payload: P): Promise<Committed | false> {
	const rules = ctx.rulesVersion;
	if (rules === undefined) return false;
	const db = engineDb(rawDb);
	const fctx: FlatContext = {
		playerId: ctx.playerId,
		now: ctx.now,
		config: ctx.config,
		rulesVersion: rules,
		db,
		upgradeAt: ctx.upgrade?.at,
	};
	const asked = flat.derived?.(payload, fctx) ?? [];
	const wanted = asked.filter((w): w is { key: string; salt?: string } => 'key' in w);
	const prefixes = asked.filter((w): w is { prefix: string; salt?: string } => 'prefix' in w);
	const reads = flat.reads(payload, fctx);
	const names = Object.keys(reads);
	const player = playerEntity(ctx.playerId);
	const [lo, hi] = tableRange(player);
	const head = [
		db.prepare('SELECT version FROM engine_locks WHERE entity = ?').bind(player),
		db.prepare('SELECT entity, version FROM engine_locks WHERE entity > ? AND entity < ?').bind(lo, hi),
		db
			.prepare(
				`SELECT key, rules, salt, codes, sum, value FROM engine_derived WHERE owner = ? AND (key IN (${wanted.map(() => '?').join(', ') || "''"})${prefixes.map(() => " OR key LIKE ? ESCAPE '\\'").join('')})`,
			)
			.bind(ctx.playerId, ...wanted.map((w) => w.key), ...prefixes.map((w) => `${w.prefix.replace(/[%_\\]/g, '\\$&')}%`)),
	];
	const out = await db.batch([...head, ...names.map((n) => reads[n])]);
	const versions = new Map<string, number>();
	for (const r of out[1].results as { entity: string; version: number }[]) {
		const code = codeOf(r.entity.slice(lo.length));
		versions.set(code, (versions.get(code) ?? 0) + r.version);
	}
	const stored = new Map(
		(out[2].results as { key: string; rules: number; salt: string; codes: string; sum: number; value: string }[]).map((r) => [r.key, r]),
	);
	const derived: Record<string, unknown> = {};
	const fresh = (row: { rules: number; salt: string; codes: string; sum: number } | undefined, salt = ''): row is NonNullable<typeof row> =>
		!!row && row.rules === rules && row.salt === salt && sumOf(row.codes.match(/.{4}/g) ?? [], versions) === row.sum;
	for (const w of wanted) {
		const row = stored.get(w.key);
		if (!fresh(row, w.salt)) return false;
		derived[w.key] = JSON.parse(row.value);
	}
	for (const w of prefixes)
		for (const [key, row] of stored)
			if (key.startsWith(w.prefix) && !(key in derived) && fresh(row, w.salt)) derived[key] = JSON.parse(row.value);
	const rows = Object.fromEntries(names.map((n, i) => [n, out[head.length + i].results as Record<string, unknown>[]]));
	const writes = await flat.run({ ...fctx, payload, rows, derived });
	if (writes === null) return false;
	const version = (out[0].results[0] as { version: number } | undefined)?.version ?? 0;
	if (!writes.length) return { before: version, after: version, written: new Set() };
	const lock = db
		.prepare('INSERT INTO engine_locks (entity, version) VALUES (?, ?) ON CONFLICT (entity) DO UPDATE SET version = excluded.version')
		.bind(player, version + 1);
	try {
		await db.batch([lock, ...bumpTables(db, [player], writes), ...coalesce(db, writes)]);
	} catch (err) {
		// Someone else committed for this player meanwhile: the regular path reads afresh and retries.
		if (err instanceof Error && err.message.includes(CONFLICT)) return false;
		throw err;
	}
	return { before: version, after: version + 1, written: writtenCodes(writes) };
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
): Promise<{ carried: Carried; committed: Committed; flat?: true }> {
	const command = kernel.commands.get(type);
	if (!command || (command.privileged && !ctx.privileged)) {
		// Privileged commands are indistinguishable from unknown ones to regular players.
		throw new GameError('unknown_command', 'Unknown command "{0}"', 404, 'kernel', { 0: type });
	}
	const payload = command.parse(rawPayload);
	const fast = command.flat && !ctx.noFlat ? await runFlat(db, ctx, command.flat, payload) : false;
	if (fast) {
		kernel.hooks.emit('engine:command', { playerId: ctx.playerId, type, payload });
		return { carried: new Map(), committed: fast, flat: true };
	}
	db = packReads(db);
	for (let i = 1; ; i++) {
		// What the successful attempt kept current, for the views of the same request (`computeViews(…, carried)`).
		const keep = new Map<string, Promise<unknown>>();
		try {
			const preload = command.preload;
			const committed = await attempt(
				kernel,
				db,
				ctx,
				(api) => command.execute(api, payload),
				keep,
				preload && ((api) => preload.call(command, api, payload)),
			);
			kernel.hooks.emit('engine:command', { playerId: ctx.playerId, type, payload });
			return { carried: keep, committed };
		} catch (err) {
			const conflict = err instanceof Error && err.message.includes(CONFLICT);
			if (!conflict) throw err;
			if (i >= MAX_ATTEMPTS) throw new GameError('busy', 'Too many simultaneous changes, please retry', 409);
		}
	}
}
