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
import { coalesce, recording } from './coalesce';
import { resolveConfig } from './config';
import { GameError } from './errors';
import type { Kernel } from './kernel';
import type { EngineApi, EngineContext, MemoOptions, ReadApi, Report, ViewParams } from './types';

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

function readApi(kernel: Kernel, db: D1Database, ctx: EngineContext, carried?: Carried, keep?: Map<string, Promise<unknown>>): ReadApi {
	const cache = new Map<string, Promise<unknown>>(carried ?? []);
	const fresh = new Set<string>();
	return {
		...ctx,
		db,
		services: kernel.services,
		memo<T>(key: string, load: () => Promise<T>, options?: MemoOptions): Promise<T> {
			if (!cache.has(key)) cache.set(key, load());
			if (options?.current) keep?.set(key, cache.get(key)!);
			return cache.get(key) as Promise<T>;
		},
		peek: <T>(key: string) => cache.get(key) as Promise<T> | undefined,
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
	};
}

/**
 * A view stamp for what only commits touching the player (theirs, and others' that lock them) and the rules change:
 * one row read. Views add what else moves theirs (e.g. events falling due).
 */
export const playerStamp = async (api: ReadApi) => `${await api.version(playerEntity(api.playerId))}|${api.rulesVersion ?? 0}`;

/** An `EngineApi` whose writes, commit hooks and locks do nothing (for views). */
function dryRunApi(kernel: Kernel, db: D1Database, ctx: EngineContext, carried?: Carried): EngineApi {
	return { ...readApi(kernel, db, ctx, carried), write() {}, beforeCommit() {}, async lock() {} };
}

/**
 * Current state for the acting player: the requested views (all by default), and `instances`: views computed
 * again with their own parameters on top of `params` (e.g. the forms of each form area the client shows), so
 * one request answers for the whole screen. Never writes.
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
): Promise<ClientState> {
	// One shared api: views reuse each other's loaded rows through `memo` (and those a command just kept current).
	const api = dryRunApi(kernel, db, ctx, carried);
	const wanted = ids ? kernel.views.filter((v) => ids.includes(v.id)) : kernel.views;
	const byId = new Map(kernel.views.map((v) => [v.id, v]));
	const stamps: Record<string, string> = {};
	// A stamp holds only under the same parameters (another settlement, another hero picked): they are part of it, so
	// a view's own stamp needs to say nothing about them.
	const under = JSON.stringify(Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
	const [entries, extra] = await Promise.all([
		Promise.all(
			wanted.map(async (v) => {
				const stamp = v.stamp ? `${await v.stamp(api, params)}|${under}` : undefined;
				if (stamp !== undefined) stamps[v.id] = stamp;
				return stamp !== undefined && held[v.id] === stamp ? null : ([v.id, await v.compute(api, params)] as const);
			}),
		),
		Promise.all(
			instances.flatMap((i) => {
				const v = byId.get(i.view);
				return v ? [(async () => [i.key, await v.compute(api, { ...params, ...i.params })] as const)()] : [];
			}),
		),
	]);
	return {
		now: ctx.now,
		views: Object.fromEntries(entries.filter((e) => e !== null)),
		...(extra.length ? { instances: Object.fromEntries(extra) } : {}),
		...(Object.keys(stamps).length ? { stamps } : {}),
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
	const writes: D1PreparedStatement[] = [];
	const flushers = new Map<string, () => void | Promise<void>>();

	const api: EngineApi = {
		...readApi(kernel, db, ctx, undefined, keep),
		write: (...statements) => void writes.push(...statements),
		beforeCommit(key, fn) {
			if (!flushers.has(key)) flushers.set(key, fn);
		},
		async lock(entity) {
			if (locks.has(entity)) return;
			const row = await db.prepare('SELECT version FROM engine_locks WHERE entity = ?').bind(entity).first<{ version: number }>();
			locks.set(entity, row?.version ?? 0);
		},
	};

	await api.lock(playerEntity(ctx.playerId));
	await execute(api);
	// Flushers may queue more writes (a Map iterates entries added during iteration too).
	for (const fn of flushers.values()) await fn();
	if (writes.length === 0) return;

	const bumps = [...locks].map(([entity, version]) =>
		db
			.prepare('INSERT INTO engine_locks (entity, version) VALUES (?, ?) ON CONFLICT (entity) DO UPDATE SET version = excluded.version')
			.bind(entity, version + 1),
	);
	await db.batch([...bumps, ...coalesce(db, writes)]);
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
