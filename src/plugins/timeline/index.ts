/**
 * Timeline: things that happen at a point in time for an entity — a building finishing,
 * (later) an army arriving.
 *
 * Events are processed lazily and in order, the first time an entity's state is needed
 * (`sync`). Before each event, clock listeners bring time-dependent state up to the
 * event's due time (e.g. resources credit production at the OLD rate up to the moment a
 * farm finishes upgrading); then the event's handler applies its change. After the last
 * due event, readers advance the rest of the way to `now` themselves.
 *
 * In a command, processed events are deleted in the same atomic commit. In a view
 * (dry-run) they are processed in memory only, so reads are always up to date.
 *
 * A cron task (`timeline.sweep`, every minute) also processes due events of entities nobody
 * looked at, so things happen on time even for offline players (armies arriving...). Each
 * entity is processed as a command of its owner, so it takes the usual locks.
 * Plugins owning entity kinds register `addOwnerResolver` (e.g. "settlement" -> its owner).
 */
import { definePlugin, executeCommand, GameError, PluginError, type EngineApi } from '../../kernel';
import { requestContext } from '../../runtime/context';

export interface TimelineEvent<P = unknown> {
	id: string;
	entity: string;
	dueAt: number;
	type: string;
	payload: P;
}

/** Applies an event. `api.now` stays the real present; the event happened at `event.dueAt`. */
export type EventHandler<P = unknown> = (api: EngineApi, event: TimelineEvent<P>) => Promise<void>;

/** Brings an entity's time-dependent state forward to time `t`. */
export type ClockListener = (api: EngineApi, entity: string, t: number) => Promise<void>;

export interface TimelineService {
	on<P>(type: string, handler: EventHandler<P>): void;
	onAdvance(listener: ClockListener): void;
	/** Queue a new event (may be due already while catching up; it is then processed in the same sync). Returns its id. */
	schedule<P>(api: EngineApi, entity: string, dueAt: number, type: string, payload: P): string;
	/** Queue removal of a not-yet-processed event. */
	cancel(api: EngineApi, id: string): void;
	/** Queue removal of pending events of `type` for `entity` whose payload contains `match` (top-level fields). */
	cancelWhere(api: EngineApi, entity: string, type: string, match: Record<string, string | number>): void;
	/** How to find the player owning entities with this prefix (e.g. "settlement"); null = no owner (NPC). */
	addOwnerResolver(prefix: string, resolve: (db: D1Database, id: string) => Promise<string | null>): void;
	/** Process every event of `entity` that is due by `api.now`. Safe to call repeatedly. */
	sync(api: EngineApi, entity: string): Promise<void>;
}

declare module '../../kernel' {
	interface ServiceMap {
		timeline: TimelineService;
	}
}

/** Marks an api as "inside the sync of these entities", so nested sync calls return at once. */
const SYNCING = Symbol('timeline.syncing');
type Marked = EngineApi & { [SYNCING]?: ReadonlySet<string> };

/** An event known in this call: loaded from storage or scheduled during it. */
interface Pending extends TimelineEvent {
	/** Tie-breaker for events due at the same time: creation order. */
	seq: number;
}
let seq = 0;

interface Row {
	id: string;
	entity: string;
	due_at: number;
	type: string;
	payload: string;
}

export default definePlugin({
	id: 'timeline',
	version: '0.1.0',
	description: 'Timed events per entity, processed in order before reads',
	setup(ctx) {
		const handlers = new Map<string, EventHandler>();
		const scheduledIn = (api: EngineApi, entity: string) => api.memo(`timeline:scheduled:${entity}`, async (): Promise<Pending[]> => []);
		const listeners: ClockListener[] = [];
		const owners = new Map<string, (db: D1Database, id: string) => Promise<string | null>>([['player', async (_db, id) => id]]);

		const service: TimelineService = {
			on(type, handler) {
				if (handlers.has(type)) throw new PluginError(`Timeline handler for "${type}" registered twice`);
				handlers.set(type, handler as EventHandler);
			},
			onAdvance: (l) => void listeners.push(l),
			addOwnerResolver(prefix, resolve) {
				if (owners.has(prefix)) throw new PluginError(`Owner resolver for "${prefix}" registered twice`);
				owners.set(prefix, resolve);
			},

			schedule(api, entity, dueAt, type, payload) {
				if (!handlers.has(type)) throw new PluginError(`No timeline handler for "${type}"`);
				const id = crypto.randomUUID();
				api.write(
					api.db
						.prepare('INSERT INTO timeline_events (id, entity, due_at, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
						.bind(id, entity, dueAt, type, JSON.stringify(payload), api.now),
				);
				// Remember it for this call: while catching up, an event scheduled by another event may
				// already be due (e.g. an army that arrived hours ago was due back an hour ago).
				void scheduledIn(api, entity).then((list) => list.push({ id, entity, dueAt, type, payload, seq: seq++ }));
				return id;
			},
			cancel(api, id) {
				api.write(api.db.prepare('DELETE FROM timeline_events WHERE id = ?').bind(id));
			},

			cancelWhere(api, entity, type, match) {
				const keys = Object.keys(match);
				for (const k of keys) if (!/^\w+$/.test(k)) throw new PluginError(`Invalid payload key "${k}"`);
				api.write(
					api.db
						.prepare(
							`DELETE FROM timeline_events WHERE entity = ? AND type = ? AND due_at > ?${keys.map((k) => ` AND json_extract(payload, '$.${k}') = ?`).join('')}`,
						)
						.bind(entity, type, api.now, ...keys.map((k) => match[k])),
				);
			},

			sync(api, entity) {
				if ((api as Marked)[SYNCING]?.has(entity)) return Promise.resolve();
				return api.memo(`timeline:sync:${entity}`, async () => {
					const inner: Marked = { ...api, [SYNCING]: new Set([...((api as Marked)[SYNCING] ?? []), entity]) };
					const { results } = await api.db
						.prepare(
							'SELECT id, entity, due_at, type, payload FROM timeline_events WHERE entity = ? AND due_at <= ? ORDER BY due_at, created_at',
						)
						.bind(entity, api.now)
						.all<Row>();
					const stored: Pending[] = results.map((r, i) => ({
						id: r.id,
						entity: r.entity,
						dueAt: r.due_at,
						type: r.type,
						payload: JSON.parse(r.payload),
						seq: -results.length + i,
					}));
					const fresh = await scheduledIn(api, entity);
					const done = new Set<string>();
					// Process in time order until nothing is due, including events scheduled on the way.
					for (;;) {
						const next = [...stored, ...fresh]
							.filter((e) => e.dueAt <= api.now && !done.has(e.id))
							.sort((a, b) => a.dueAt - b.dueAt || a.seq - b.seq)[0];
						if (!next) break;
						done.add(next.id);
						const handler = handlers.get(next.type);
						if (!handler) throw new PluginError(`No timeline handler for "${next.type}" (plugin disabled?)`);
						for (const advance of listeners) await advance(inner, entity, next.dueAt);
						await handler(inner, { id: next.id, entity, dueAt: next.dueAt, type: next.type, payload: next.payload });
						service.cancel(inner, next.id);
					}
				});
			},
		};

		ctx.services.provide('timeline', service);

		// Internal: process one entity's due events as a command (run by the sweep).
		ctx.commands.add<{ entity: string }>({
			type: 'timeline.sync',
			privileged: true,
			description: 'Process due timeline events of an entity now. Payload: { "entity": "settlement:<id>" }',
			parse(raw) {
				const entity = (raw as { entity?: unknown } | null)?.entity;
				if (typeof entity !== 'string') throw new GameError('bad_payload', 'entity is required');
				return { entity };
			},
			execute: (api, { entity }) => service.sync(api, entity),
		});

		const sweepBatch = ctx.config.define('sweepBatch', {
			description: 'Entities processed per sweep (every minute).',
			default: () => 200,
			parse: (raw) => {
				const n = Number(raw);
				if (!Number.isInteger(n) || n < 1 || n > 5000) throw new GameError('bad_config', 'Expected an integer 1-5000');
				return n;
			},
		});

		ctx.tasks.add({
			id: 'timeline.sweep',
			async run({ kernel, env, now }) {
				const probe = await requestContext(kernel, env, 'system');
				const { results } = await env.DB.prepare('SELECT DISTINCT entity FROM timeline_events WHERE due_at <= ? LIMIT ?')
					.bind(now, sweepBatch.get(probe))
					.all<{ entity: string }>();
				for (const { entity } of results) {
					const i = entity.indexOf(':');
					const resolve = owners.get(entity.slice(0, i));
					try {
						const owner = resolve ? await resolve(env.DB, entity.slice(i + 1)) : null;
						// Ownerless entities (NPC) lock on themselves.
						const context = await requestContext(kernel, env, owner ?? `npc:${entity}`, true);
						await executeCommand(kernel, env.DB, context, 'timeline.sync', { entity });
					} catch (err) {
						console.error(`timeline.sweep: ${entity} failed`, err);
					}
				}
			},
		});
	},
});
