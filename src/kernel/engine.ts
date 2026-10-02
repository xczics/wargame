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
import type { ClientState } from '../shared/api';
import { resolveConfig } from './config';
import { GameError } from './errors';
import type { Kernel } from './kernel';
import type { EngineApi, EngineContext, ReadApi, Report, ViewParams } from './types';

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

function readApi(kernel: Kernel, db: D1Database, ctx: EngineContext): ReadApi {
	const cache = new Map<string, Promise<unknown>>();
	return {
		...ctx,
		db,
		services: kernel.services,
		memo<T>(key: string, load: () => Promise<T>): Promise<T> {
			if (!cache.has(key)) cache.set(key, load());
			return cache.get(key) as Promise<T>;
		},
	};
}

/** An `EngineApi` whose writes, commit hooks and locks do nothing (for views). */
function dryRunApi(kernel: Kernel, db: D1Database, ctx: EngineContext): EngineApi {
	return { ...readApi(kernel, db, ctx), write() {}, beforeCommit() {}, async lock() {} };
}

/** Current state for the acting player: the requested views (all by default). Never writes. */
export async function computeViews(
	kernel: Kernel,
	db: D1Database,
	ctx: EngineContext,
	ids?: string[],
	params: ViewParams = {},
): Promise<ClientState> {
	// One shared api: views reuse each other's loaded rows through `memo`.
	const api = dryRunApi(kernel, db, ctx);
	const wanted = ids ? kernel.views.filter((v) => ids.includes(v.id)) : kernel.views;
	const entries = await Promise.all(wanted.map(async (v) => [v.id, await v.compute(api, params)] as const));
	return { now: ctx.now, views: Object.fromEntries(entries) };
}

export async function runReport(kernel: Kernel, db: D1Database, ctx: EngineContext, id: string, params: unknown) {
	const report: Report | undefined = kernel.reports.get(id);
	if (!report) throw new GameError('unknown_report', `Unknown report "${id}"`, 404);
	return report.run(readApi(kernel, db, ctx), params);
}

async function attempt(kernel: Kernel, db: D1Database, ctx: EngineContext, execute: (api: EngineApi) => Promise<void>): Promise<void> {
	const locks = new Map<string, number>();
	const writes: D1PreparedStatement[] = [];
	const flushers = new Map<string, () => void | Promise<void>>();

	const api: EngineApi = {
		...readApi(kernel, db, ctx),
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
	await db.batch([...bumps, ...writes]);
}

/**
 * Parse and run one command, committing its writes atomically. Retries on lock conflicts;
 * throws `GameError` for rejected commands (nothing is written in that case).
 */
export async function executeCommand(kernel: Kernel, db: D1Database, ctx: EngineContext, type: string, rawPayload: unknown): Promise<void> {
	const command = kernel.commands.get(type);
	if (!command || (command.privileged && !ctx.privileged)) {
		// Privileged commands are indistinguishable from unknown ones to regular players.
		throw new GameError('unknown_command', `Unknown command "${type}"`, 404);
	}
	const payload = command.parse(rawPayload);
	for (let i = 1; ; i++) {
		try {
			await attempt(kernel, db, ctx, (api) => command.execute(api, payload));
			kernel.hooks.emit('engine:command', { playerId: ctx.playerId, type, payload });
			return;
		} catch (err) {
			const conflict = err instanceof Error && err.message.includes(CONFLICT);
			if (!conflict) throw err;
			if (i >= MAX_ATTEMPTS) throw new GameError('busy', 'Too many simultaneous changes, please retry', 409);
		}
	}
}
