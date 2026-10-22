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
 *
 * The browser commits a player's due events itself when they fall due (changelog 420): its alarm sends the light
 * command `timeline.settle` (meta `wake`) instead of a sync, so the views after it, and every sync later, read what
 * is committed instead of working the same events out in memory again and again. `timeline.due` (on every page) tells
 * the browser when the next one falls due, or that one has and is still uncommitted. Both find the player's events by
 * their owner column (`player`, filled in from `addOwnerResolver`'s SQL).
 */
import {
	definePlugin,
	type EngineApi,
	executeCommand,
	type FlatContext,
	fields,
	gameErrors,
	playerStamp,
	PluginError,
	shape,
} from '../../kernel';
import { requestContext } from '../../runtime/context';
import type { SyncData } from '../../shared/ui';
import i18nCsv from './data/i18n.csv?raw';

const fail = gameErrors('timeline');

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
	/**
	 * How to find the player owning entities with this prefix (e.g. "settlement"); null = no owner (NPC). `sql`: the
	 * same as an SQL expression of the id `{id}`, e.g. `(SELECT owner_id FROM settlements_settlements WHERE id = {id})`:
	 * each event is stored with its owner (filled in at commit, in one statement), so the owner's syncs see it fall due
	 * (an unchanged sync is answered from one read only while nothing of theirs is due). Without it their events wake
	 * nobody's views: give it whenever the entity's events change what its owner sees.
	 */
	addOwnerResolver(prefix: string, resolve: (db: D1Database, id: string) => Promise<string | null>, sql?: string): void;
	/**
	 * Process every event of `entity` that is due by `api.now`. Safe to call repeatedly: a later
	 * call in the same command processes what became due since (e.g. an event just scheduled
	 * for `api.now`), never an event twice.
	 */
	sync(api: EngineApi, entity: string): Promise<void>;
	/** True inside the handling of `entity`'s own events (its clock is at the event's time, not `api.now`). */
	syncing(api: EngineApi, entity: string): boolean;
	/**
	 * How many of `entity`'s stored events are due by `api.now` (the same read `sync` makes): e.g. part of a view's
	 * stamp, as what is due changes the entity even before it is written.
	 */
	due(api: EngineApi, entity: string): Promise<number>;
	/**
	 * Read what is due of several entities in one query (e.g. all of a player's settlements, before going through them
	 * one by one): their `sync` / `due` then need no read of their own. Those read already in this call are left out.
	 */
	preload(api: EngineApi, entities: string[]): void;
	/** Flat commands (`Command.flat`): the read of how many of `entity`'s events are due (row `{ n }`). */
	flatDue(f: FlatContext, entity: string): D1PreparedStatement;
	/** Flat commands: a new event of `owner`'s entity, as the statement to commit (stored with its owner). */
	flatSchedule<P>(f: FlatContext, entity: string, dueAt: number, type: string, payload: P, owner: string): D1PreparedStatement;
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
	dependsOn: ['ui', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv, ctx.pluginId);
		const handlers = new Map<string, EventHandler>();
		const scheduledIn = (api: EngineApi, entity: string) => api.memo(`timeline:scheduled:${entity}`, async (): Promise<Pending[]> => []);
		const listeners: ClockListener[] = [];
		const owners = new Map<string, (db: D1Database, id: string) => Promise<string | null>>([['player', async (_db, id) => id]]);
		const ownerSql = new Map<string, string>([['player', '{id}']]);
		/**
		 * Each event is its owner's (`player`), so a sync asks in one lookup whether anything of the player's fell due
		 * (`ctx.views.wake` below). Filled in at commit by the owner plugins' SQL (`addOwnerResolver`), one statement per
		 * kind of entity: `schedule` cannot wait for a read, and the entity may be one this commit makes (a march). An
		 * event the same command processed is gone by then (the update finds nothing). A hook scheduling more after this
		 * one ran gets another one.
		 */
		// By the call's database (the same for every copy of its api; a command's attempt has its own).
		const unowned = new WeakMap<D1Database, { list: { id: string; entity: string }[]; hooked: boolean }>();
		let hooks = 0;
		const own = (api: EngineApi, id: string, entity: string) => {
			let u = unowned.get(api.db);
			if (!u) unowned.set(api.db, (u = { list: [], hooked: false }));
			u.list.push({ id, entity });
			if (u.hooked) return;
			u.hooked = true;
			const state = u;
			api.beforeCommit(
				`timeline.owners:${++hooks}`,
				() => {
					state.hooked = false;
					const byKind = new Map<string, string[]>();
					for (const e of state.list.splice(0)) {
						const kind = e.entity.slice(0, e.entity.indexOf(':'));
						if (ownerSql.has(kind)) byKind.set(kind, [...(byKind.get(kind) ?? []), e.id]);
					}
					for (const [kind, ids] of byKind) {
						const owner = ownerSql.get(kind)!.replaceAll('{id}', `substr(timeline_events.entity, ${kind.length + 2})`);
						for (let i = 0; i < ids.length; i += 90) {
							const chunk = ids.slice(i, i + 90);
							api.write(
								api.db
									.prepare(`UPDATE timeline_events SET player = ${owner} WHERE id IN (${chunk.map(() => '?').join(', ')})`)
									.bind(...chunk),
							);
						}
					}
				},
				{ writes: ['timeline_events'] },
			);
		};
		ctx.views.wake((db, playerId, now) =>
			db.prepare('SELECT 1 AS due FROM timeline_events WHERE player = ? AND due_at <= ? LIMIT 1').bind(playerId, now),
		);

		// Stored events due by now, read once per call (sync works through them; `due` counts them).
		const stateOf = (results: Row[]) => ({
			stored: results.map((r, i): Pending => ({
				id: r.id,
				entity: r.entity,
				dueAt: r.due_at,
				type: r.type,
				payload: JSON.parse(r.payload),
				seq: -results.length + i,
			})),
			done: new Set<string>(),
			running: Promise.resolve(),
		});
		const syncState = (api: EngineApi, entity: string) =>
			api.memo(`timeline:sync:${entity}`, async () => {
				const { results } = api.isFresh(entity)
					? { results: [] as Row[] }
					: await api.db
							.prepare(
								'SELECT id, entity, due_at, type, payload FROM timeline_events WHERE entity = ? AND due_at <= ? ORDER BY due_at, created_at',
							)
							.bind(entity, api.now)
							.all<Row>();
				return stateOf(results);
			});
		/** Several entities' due events in one query, put where `syncState` looks (only those not read yet). */
		function preload(api: EngineApi, entities: string[]) {
			const missing = [...new Set(entities)].filter((e) => !api.isFresh(e) && !api.peek(`timeline:sync:${e}`));
			if (!missing.length) return;
			// One: its own read, started now (e.g. a command's preload).
			if (missing.length === 1) return void syncState(api, missing[0]).catch(() => {});
			const batch = (async () => {
				const byEntity = new Map<string, Row[]>();
				for (let i = 0; i < missing.length; i += 90) {
					const chunk = missing.slice(i, i + 90);
					const { results } = await api.db
						.prepare(
							`SELECT id, entity, due_at, type, payload FROM timeline_events WHERE entity IN (${chunk.map(() => '?').join(', ')}) AND due_at <= ? ORDER BY due_at, created_at`,
						)
						.bind(...chunk, api.now)
						.all<Row>();
					for (const r of results) byEntity.set(r.entity, [...(byEntity.get(r.entity) ?? []), r]);
				}
				return byEntity;
			})();
			for (const e of missing) void api.memo(`timeline:sync:${e}`, async () => stateOf((await batch).get(e) ?? []));
		}
		const service: TimelineService = {
			preload,
			on(type, handler) {
				if (handlers.has(type)) throw new PluginError(`Timeline handler for "${type}" registered twice`);
				handlers.set(type, handler as EventHandler);
			},
			onAdvance: (l) => void listeners.push(l),
			addOwnerResolver(prefix, resolve, sql) {
				if (owners.has(prefix)) throw new PluginError(`Owner resolver for "${prefix}" registered twice`);
				owners.set(prefix, resolve);
				if (sql) ownerSql.set(prefix, sql);
			},

			schedule(api, entity, dueAt, type, payload) {
				if (!handlers.has(type)) throw new PluginError(`No timeline handler for "${type}"`);
				const id = crypto.randomUUID();
				api.write(
					api.db
						.prepare('INSERT INTO timeline_events (id, entity, due_at, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)')
						.bind(id, entity, dueAt, type, JSON.stringify(payload), api.now),
				);
				own(api, id, entity);
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

			syncing: (api, entity) => !!(api as Marked)[SYNCING]?.has(entity),
			due: async (api, entity) => (await syncState(api, entity)).stored.length,
			flatDue: (f, entity) =>
				f.db.prepare('SELECT COUNT(*) AS n FROM timeline_events WHERE entity = ? AND due_at <= ?').bind(entity, f.now),
			flatSchedule(f, entity, dueAt, type, payload, owner) {
				if (!handlers.has(type)) throw new PluginError(`No timeline handler for "${type}"`);
				return f.db
					.prepare('INSERT INTO timeline_events (id, entity, due_at, type, payload, created_at, player) VALUES (?, ?, ?, ?, ?, ?, ?)')
					.bind(crypto.randomUUID(), entity, dueAt, type, JSON.stringify(payload), f.now, owner);
			},
			async sync(api, entity) {
				if (service.syncing(api, entity)) return;
				// Stored events are read once per call; what was processed is remembered, so passes
				// run one after another and a later pass only picks up events that became due since.
				const state = await syncState(api, entity);
				const pass = async () => {
					const inner: Marked = { ...api, [SYNCING]: new Set([...((api as Marked)[SYNCING] ?? []), entity]) };
					const { stored, done } = state;
					const fresh = await scheduledIn(api, entity);
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
				};
				state.running = state.running.then(pass);
				await state.running;
			},
		};

		ctx.services.provide('timeline', service);

		// Internal: process one entity's due events as a command (run by the sweep).
		ctx.commands.add<{ entity: string }>({
			type: 'timeline.sync',
			privileged: true,
			description: 'Process due timeline events of an entity now. Payload: { "entity": "settlement:<id>" }',
			parse: shape({ entity: fields.id() }),
			execute: (api, { entity }) => service.sync(api, entity),
		});

		// The browser's alarm (meta `wake`): commit the player's due events, once, so later reads find them committed. Safe
		// to repeat and to run side by side (the player's lock; a retry finds them gone): nothing due, nothing written.
		ctx.commands.add<null>({
			type: 'timeline.settle',
			description: 'Commit the events of your settlements, armies… that are due now. No payload.',
			parse: () => null,
			async execute(api) {
				// The player's entities with something due (the owner column, its index): earliest first.
				const { results } = await api.db
					.prepare('SELECT entity, MIN(due_at) AS at FROM timeline_events WHERE player = ? AND due_at <= ? GROUP BY entity ORDER BY at')
					.bind(api.playerId, api.now)
					.all<{ entity: string; at: number }>();
				if (!results.length) return;
				const entities = results.map((r) => r.entity);
				// Their events in one read.
				preload(api, entities);
				for (const entity of entities) await service.sync(api, entity);
			},
		});
		ctx.meta.add('wake', () => 'timeline.settle');

		// When the browser should wake (generic `ui.sync`, every page): the player's next event, or one due and not
		// committed yet (in the past: the browser settles it once). Quiet: changed only by commits touching the player's
		// events; while one of them is due (`views.wake` above) it is worked out, and shows it.
		ctx.views.add({
			id: 'timeline.due',
			quiet: true,
			stamp: playerStamp,
			async compute(api): Promise<SyncData> {
				const at = await api.db
					.prepare('SELECT MIN(due_at) AS at FROM timeline_events WHERE player = ?')
					.bind(api.playerId)
					.first<number | null>('at');
				return { items: at === null ? [] : [{ at }] };
			},
		});
		ctx.services.get('ui').band({ band: 'top', widget: 'ui.sync', props: { view: 'timeline.due' } });

		const sweepBatch = ctx.config.define('sweepBatch', {
			description: 'Entities processed per sweep (every minute).',
			default: () => 200,
			parse: (raw) => {
				const n = Number(raw);
				if (!Number.isInteger(n) || n < 1 || n > 5000) throw fail('bad_config', 'Expected an integer 1-5000');
				return n;
			},
		});

		ctx.tasks.add({
			id: 'timeline.sweep',
			async run({ kernel, env, now }) {
				// Nothing due (most runs while nobody plays): one small read by the due index, nothing worked out.
				if (!(await env.DB.prepare('SELECT 1 FROM timeline_events WHERE due_at <= ? LIMIT 1').bind(now).first())) return;
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
