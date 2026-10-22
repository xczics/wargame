/**
 * Kernel contracts. Everything the game does is contributed by a plugin through
 * one of the extension points on `PluginContext`; the kernel itself has no game logic.
 *
 * Game data lives in D1. Each plugin owns its own tables (prefixed with its id) and
 * exposes typed services to read/write them. Commands read what they need, queue
 * writes, and the engine commits them as ONE atomic batch guarded by optimistic locks.
 *
 * Cross-plugin typing uses declaration merging: a plugin that provides a service or
 * emits a hook augments `ServiceMap` / `HookMap` from its own module, e.g.
 *
 *   declare module "../../kernel" {
 *     interface ServiceMap { resources: ResourcesService }
 *   }
 */
import type { FormPatch, FormSpec } from '../shared/api';
import type { Kernel } from './kernel';

/** Services plugins expose to each other, keyed by service name. Augmented by plugins. */
export interface ServiceMap {
	/**
	 * Well-known, optional: where GM-edited config overrides are persisted. The runtime
	 * loads overrides through it when some plugin provides it; otherwise defaults apply.
	 */
	configStore: ConfigStore;
}

export interface ConfigStore {
	/**
	 * Raw (unvalidated) overrides by full config key, and a version that moves on whenever they change (read
	 * together: the rules' version tells cached rule-built data, e.g. static views, when to be worked out again).
	 */
	load(env: Env): Promise<{ overrides: Record<string, unknown>; version: number }>;
	/**
	 * Optional: the version alone (one small read). With it, rules are worked out again only when it moved, so it must
	 * move with every change of the overrides.
	 */
	version?(env: Env): Promise<number>;
	/**
	 * Optional: drop overrides whose key no plugin defines any more (renamed or removed rules).
	 * Called by the runtime when it finds such keys, so they never linger across deploys.
	 */
	prune?(env: Env, keys: string[]): Promise<void>;
	/**
	 * Optional: move the version on in this command's commit, for content a static view reads from the database
	 * (e.g. a tech the GM added for everyone): the static views are baked again.
	 */
	touch?(api: EngineApi): void;
}

/** Hook (event) payloads, keyed by hook name. Augmented by plugins. */
export interface HookMap {
	/** Emitted by the engine after a command has been committed. */
	'engine:command': { playerId: string; type: string; payload: unknown };
}

/** Effective config values (defaults merged with validated overrides), by full key. */
export type ConfigSnapshot = Readonly<Record<string, unknown>>;

/** Who / when / under which rules an engine call runs. Built by the runtime per request. */
export interface EngineContext {
	playerId: string;
	/** Epoch ms "now" for this call. Engine callbacks must use this, never `Date.now()`. */
	now: number;
	config: ConfigSnapshot;
	/** True when the caller is allowed to run `privileged` commands (e.g. a GM). */
	privileged?: boolean;
	/** Run commands' regular `execute` even where they have a flat form (tests comparing the two, the bench). */
	noFlat?: boolean;
	/**
	 * The person looking is the GM (playing their own account, or in the GM console). Only for
	 * showing more (e.g. odds players do not see); it grants nothing — `privileged` does.
	 */
	gmViewer?: boolean;
	/** The rules' version (moves on with every GM change): static views are baked per version. */
	rulesVersion?: number;
	/** Object storage (the deployment's file bucket), if any. Engine callbacks read it through `ReadApi.files` and write through `EngineApi.putFile`. */
	files?: FileStore;
	/**
	 * After a server upgrade: when this version started serving, and the rules in force before it (what the earlier
	 * version had, GM overrides included). Owners of values that accrue over time settle time before `at` under
	 * `config` (`ReadApi.beforeUpgrade`), then go on under the current rules. `config` is read only when asked for (a
	 * file of ~1.5 MB: most requests never need it).
	 */
	upgrade?: { at: number; config: () => Promise<ConfigSnapshot> };
}

/** Where engine callbacks keep big, rarely changing data (a map file, pictures): object storage, not the database. */
export interface FileStore {
	get(key: string): Promise<string | null>;
	put(key: string, body: string, options?: FileOptions): Promise<void>;
}
export interface FileOptions {
	contentType?: string;
	cacheControl?: string;
}

/**
 * A static view: what a screen shows that does not depend on the player (content and rules: e.g. the realms and
 * their tasks, the tech tree, the shop's offers). Baked once per rules version (only those reading a changed rule
 * again), kept in the static store, sent to clients once by version and cached there; the player's views carry only
 * what changes, referring to it by id (AGENTS.md, "performance").
 */
export interface StaticView {
	/** `<pluginId>.<name>`. */
	id: string;
	/** Must only read: the rules (`handle.get(rules)`) and, when it must, content tables (e.g. nodes the GM added). */
	compute(input: { rules: RuleView; db: D1Database }): unknown | Promise<unknown>;
	/**
	 * It reads content tables, which no rule tracks: baked again whenever the rules' version moves on (whoever edits
	 * those tables moves it on, `configStore.touch`). Without it, only views that read a changed rule are baked again.
	 */
	content?: boolean;
}
export interface ReadApi extends Readonly<Omit<EngineContext, 'files'>> {
	readonly db: D1Database;
	/** Read a file of the object storage (null: none, or no storage). Reading is safe in views and retried commands. */
	readonly files?: Pick<FileStore, 'get'>;
	services: ServiceLookup;
	/**
	 * Per-call cache: the first caller runs `load`, later callers in the same command/view
	 * pass get the same promise. Use it so several plugins can share loaded rows.
	 */
	memo<T>(key: string, load: () => Promise<T>, options?: MemoOptions): Promise<T>;
	/** What `memo` already has under `key` in this call, without loading it (e.g. a full list that would do instead of a narrower query). */
	peek<T>(key: string): Promise<T> | undefined;
	/**
	 * How many commits have locked `entity` ("player:<id>": every command of the player, and others' commands that touch
	 * them): a view's `stamp` for what only commands change (one row read, not the data itself).
	 */
	version(entity: string): Promise<number>;
	/**
	 * Mark an entity ("settlement:<id>"...) as created in this call: nothing is stored about it anywhere yet, so
	 * loaders keyed by it can answer "none" without a query (`isFresh`).
	 */
	fresh(entity: string): void;
	isFresh(entity: string): boolean;
	/**
	 * After a server upgrade (`EngineContext.upgrade`): the same call as of the moment of the upgrade under the rules
	 * before it — its own cache, writes dropped — to work out what accrued until then (e.g. production at the old
	 * rates); null when there was none. One per call.
	 */
	beforeUpgrade(): Promise<EngineApi | null>;
	/**
	 * A value worked out from the database that changes only when the tables it reads do (e.g. a settlement's
	 * production rates): stored as one row and read back while, for `owner` (a player id), none of the tables `compute`
	 * read last time moved on, under the same rules and `salt` (what else it depends on, e.g. events due but not yet
	 * applied). A command stores it at commit, worked out again after its own writes if they touched those tables; views
	 * only read it (or work it out, not storing). No owner, or no rules version (engine tests): worked out every time.
	 * `compute` must read only through the api (the tables are noted) and the rules, and not depend on the clock.
	 * `ignore`: tables read on the way that the value does not depend on (e.g. `timeline_events`, read to apply due
	 * events whose results land in other tables): their changes leave it valid; the salt says what else matters (how
	 * many events are due).
	 */
	derived<T>(key: string, options: DerivedOptions, compute: () => Promise<T>): Promise<T>;
}

export interface DerivedOptions {
	owner: string | null;
	salt?: string;
	ignore?: readonly string[];
}

export interface MemoOptions {
	/**
	 * The loaded value is kept up to date by its owner as it writes (rows added to the list, amounts changed in
	 * place...), so after a command commits, the views of the same request reuse it instead of reading again.
	 * Only for values every write path of the owner updates; anything else is read afresh.
	 */
	current?: boolean;
}

/** What commands receive: reads plus a write queue that commits atomically. */
export interface EngineApi extends ReadApi {
	/** Queue statements. Nothing is written until the command finishes; then all writes commit in one batch. */
	write(...statements: D1PreparedStatement[]): void;
	/**
	 * Run `fn` once just before commit (deduplicated by `key`). Use it to flush state a
	 * plugin accumulated in memory during the command (e.g. settled resource balances). `last`: after all the
	 * others (which may still write), e.g. to store what is worked out from everything the command changed. `writes`:
	 * the tables it will write (what it changed is in memory meanwhile, so stored derived values resting on them are not
	 * read back until it ran); none named: any table.
	 */
	beforeCommit(key: string, fn: () => void | Promise<void>, options?: { last?: boolean; writes?: string[] }): void;
	/**
	 * Add an entity to this command's optimistic lock set (the acting player is always
	 * included). Call it BEFORE reading that entity's rows. If anyone else commits a
	 * change to a locked entity in the meantime, the whole command is retried.
	 */
	lock(entity: string): Promise<void>;
	/**
	 * This commit changes what another player sees without needing their lock (a mail to them): their record
	 * (`player:<id>`, and the versions of the tables written) moves on with it, so their quiet views are worked out
	 * again. `'world'`: what every player sees (the GM's mail to everyone). Nothing without writes.
	 */
	touch(entity: string): void;
	/**
	 * Store a file in the object storage with this command: the engine puts it just before the database commit, so
	 * a command never points at a file that is not there. If the commit then fails (or the command is retried), the
	 * file may stay unreferenced or be put again: name it by its content (e.g. a hash), so either is harmless.
	 */
	putFile(key: string, body: string, options?: FileOptions): void;
}

/**
 * A tunable game rule. GMs can override it at runtime; overrides take effect on the
 * next engine call for every player (including their unsettled offline time).
 */
export interface ConfigDefinition<T> {
	description: string;
	/**
	 * Default value. A function is evaluated lazily, so it may depend on content defined by later plugins, and on
	 * other rules' values: `rules` reads them like an engine call (`otherHandle.get(rules)`; no cycles).
	 */
	default: (rules: RuleView) => T;
	/** Validate an override (untrusted: comes from storage / the GM UI). Throw `GameError` with a helpful message. `rules` as above. */
	parse(raw: unknown, rules: RuleView): T;
}

/** Other rules' values while one is resolved: pass it to their handles' `get`. */
export interface RuleView {
	readonly config: ConfigSnapshot;
}

export interface ConfigHandle<T> {
	/** Full key: `<pluginId>.<name>`. */
	readonly key: string;
	get(api: { config: ConfigSnapshot }): T;
}

export interface Command<P = unknown> {
	/** Unique across all plugins; convention: `<pluginId>.<verb>`. */
	type: string;
	/** Validate & narrow untrusted client input. Throw `GameError` on bad input. */
	parse(raw: unknown): P;
	/** Read what you need, queue writes via `api.write`. Throw `GameError` to reject (nothing is written). */
	execute(api: EngineApi, payload: P): Promise<void>;
	/**
	 * Optional: what `execute` will read, started at once and not awaited (services' getters and `preload` helpers, which
	 * fill the memos `execute` then finds): those reads go to D1 in one batch with the lock, not one after another as
	 * `execute` comes to them. Reads only; anything failing here is left for `execute` to meet (it reads the same memo).
	 */
	preload?(api: EngineApi, payload: P): unknown;
	/**
	 * Optional fast path (docs/development.md §2.3 "快速通道"): the same command as one batch of reads, pure work and one
	 * batch of writes, without services, hooks or memos, for the common case. It reads what other plugins work out
	 * through derived values only; anything it does not cover (a value stale or missing, an event due, a hook with no
	 * flat form) returns `null` and the regular `execute` runs instead. Both must write the same rows (tested).
	 */
	flat?: FlatCommand<P>;
	/** Only callable with `EngineContext.privileged` (GM tools). Default false. */
	privileged?: boolean;
	/** Human-readable usage, shown in the GM console (e.g. payload shape). */
	description?: string;
	/**
	 * Optional generic UI: the client's `forms` plugin renders this form and submits the
	 * values as the payload, so simple features need no dedicated frontend code.
	 * `parse` still validates everything; the form is only a convenience.
	 */
	form?: CommandForm;
}

/** What a flat command sees: the request, the rules and the rows of its batch. */
export interface FlatContext {
	playerId: string;
	now: number;
	/** For rule handles (`handle.get(flat)`) and `config` lookups. */
	config: ConfigSnapshot;
	rulesVersion: number;
	db: D1Database;
	/** When the server was last upgraded, if its old rules may still matter (`EngineContext.upgrade`). */
	upgradeAt?: number;
}

export interface FlatInput<P> extends FlatContext {
	payload: P;
	/** Each named read's rows. */
	rows: Record<string, Record<string, unknown>[]>;
	/** The derived values asked for, valid (fresh) ones only: a missing one means the regular path. */
	derived: Record<string, unknown>;
}

export interface FlatCommand<P> {
	/** The player's derived values it needs, by key with the salt they must have been stored under. */
	derived?(payload: P, ctx: FlatContext): { key: string; salt?: string }[];
	/** Its reads, sent in one batch with the lock, the derived rows and the table versions. */
	reads(payload: P, ctx: FlatContext): Record<string, D1PreparedStatement>;
	/** The writes (committed as `execute`'s are), or null for the regular path. Rejections: `throw fail(...)`. */
	run(input: FlatInput<P>): D1PreparedStatement[] | null;
}

export interface CommandForm extends FormSpec {
	/**
	 * Decide whether the form is available right now (return `false` to hide it) and fill
	 * in dynamic parts. Runs in dry-run mode, like a view. Default: always shown.
	 */
	prepare?(api: EngineApi, params: ViewParams): Promise<false | FormPatch>;
	/**
	 * What of the form is known only once every plugin is set up but is the same for every player (e.g. one field per
	 * resource, a select's choices): added to its fixed part as a patch would be, made at deploy / a GM rule change and
	 * sent through R2, not per request.
	 */
	fixed?(): Pick<FormPatch, 'fields' | 'options'>;
}

export type { FormPatch };

/** Query-string parameters of a view request, e.g. `{ settlement: "..." }`. Untrusted. */
export type ViewParams = Readonly<Record<string, string>>;

/**
 * Derived data for the acting player, sent to the client (amounts, building options...).
 *
 * Views run in DRY-RUN mode: they get a full `EngineApi` so shared code paths (e.g.
 * processing due timeline events before reading) work unchanged, but every write is
 * discarded. Only commands persist anything.
 */
export interface View {
	id: string;
	compute(api: EngineApi, params: ViewParams): Promise<unknown>;
	/**
	 * Optional: a cheap value that changes whenever the view would (designed in, e.g. when its data was last
	 * settled; never a fingerprint of the content). The client sends back the one it holds: the same, the view is
	 * neither computed nor sent (e.g. the resource pool between production changes; the client counts on).
	 */
	stamp?(api: EngineApi, params: ViewParams): Promise<string>;
	/**
	 * Its data changes only with commits that lock (or `touch`) the player, with `touch('world')`, the rules, the day
	 * (UTC) and the player's timeline events falling due (`views.wake`): then an unchanged sync, the player's record
	 * unchanged and nothing of theirs due, leaves it out without working out its stamp, or anything (the record is read
	 * with the session: one D1 call for the whole request). A function: only under some parameters (a form area but
	 * not the map's). Without its own `stamp`, it is stamped by the tables it read (`playerStamp`), which is compared
	 * only while nothing of the player's is due (else worked out). Not for what other players' moves change without
	 * locking the player (the map around them) or what changes at times nobody scheduled (a protection running out).
	 */
	quiet?: boolean | ((params: ViewParams) => boolean);
}

/**
 * A statement whose first row, if it has one, says that something of the player's fell due by `now` that their quiet
 * views show (e.g. a timeline event of one of their settlements): the sync is then worked out as usual. Read with the
 * session on every sync: keep it to one indexed lookup.
 */
export type WakeCheck = (db: D1Database, playerId: string, now: number) => D1PreparedStatement;

/** A read-only, cross-player query for the GM console (statistics, filters). */
export interface Report {
	/** Unique; convention: `<pluginId>.<name>`. */
	id: string;
	description: string;
	/** Example params shown in the GM console, e.g. `{ "resource": "gold", "min": 1000 }`. */
	example?: unknown;
	/** Validate params (untrusted) and return table rows. `api.playerId` is the GM. */
	run(api: ReadApi, params: unknown): Promise<Record<string, unknown>[]>;
}

export interface RouteContext {
	/** The booted kernel, for introspection (plugin list, meta providers). */
	kernel: Kernel;
	request: Request;
	env: Env;
	exec: ExecutionContext;
	params: Record<string, string>;
	url: URL;
	services: ServiceLookup;
}

export type RouteHandler = (ctx: RouteContext) => Response | Promise<Response>;

export interface Route {
	method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
	/** Path pattern, `:name` segments become params, e.g. `/api/players/:id`. */
	path: string;
	handler: RouteHandler;
}

/** Periodic background work, run by the Worker's cron trigger (see wrangler.jsonc). */
export interface Task {
	/** Unique; convention: `<pluginId>.<name>`. */
	id: string;
	run(ctx: { kernel: Kernel; env: Env; now: number }): Promise<void>;
	/** Runs while a gate is closed too (e.g. the check that opens it again); others wait. */
	always?: boolean;
}

/**
 * Holds the game back before any route (e.g. a usage guard pausing it near a paid limit): `check` answers an `/api`
 * request itself (a 503...) or lets it through (null). Asked on every request: keep it cheap (cache what it reads).
 */
export interface Gate {
	/** Unique; convention: `<pluginId>.<name>`. */
	id: string;
	check(ctx: { kernel: Kernel; env: Env; request: Request; url: URL }): Promise<Response | null>;
	/** Whether it is closed now, for the cron run: background tasks then run only if `always`. */
	closed?(ctx: { kernel: Kernel; env: Env; now: number }): Promise<boolean>;
}

/** Static game data served at /api/meta (content definitions etc.). */
export type MetaProvider = () => unknown;

export interface ServiceLookup {
	get<K extends keyof ServiceMap>(name: K): ServiceMap[K];
	has(name: string): boolean;
}

export interface PluginContext {
	readonly pluginId: string;
	/**
	 * The plugin whose `setup` is running now (null afterwards), for services that record what other
	 * plugins define with them (e.g. to know whose translations a content name is in).
	 */
	caller(): string | null;
	/**
	 * Run `fn` once every plugin is set up (in plugin order; `caller()` is this plugin meanwhile), e.g. to
	 * build lookup tables from what all plugins registered. Synchronous, no game state: content only.
	 */
	onReady(fn: () => void): void;
	services: ServiceLookup & {
		provide<K extends keyof ServiceMap>(name: K, impl: ServiceMap[K]): void;
	};
	hooks: {
		on<K extends keyof HookMap>(name: K, fn: (payload: HookMap[K]) => void): void;
		emit<K extends keyof HookMap>(name: K, payload: HookMap[K]): void;
	};
	config: {
		/** Declare a tunable rule; the key is namespaced automatically: `<pluginId>.<name>`. */
		define<T>(name: string, def: ConfigDefinition<T>): ConfigHandle<T>;
	};
	commands: {
		add<P>(command: Command<P>): void;
		/** Every registered command with its owning plugin (complete once booted; use at runtime only). */
		all(): ReadonlyMap<string, Command & { owner: string }>;
	};
	views: {
		add(view: View): void;
		/** What makes a player's quiet views change by themselves (`View.quiet`): asked before any is left out. */
		wake(check: WakeCheck): void;
	};
	statics: { add(view: StaticView): void };
	reports: { add(report: Report): void };
	tasks: { add(task: Task): void };
	routes: { add(route: Route): void };
	gates: { add(gate: Gate): void };
	meta: { add(key: string, provider: MetaProvider): void };
}

export interface Plugin {
	/** Unique, kebab-case. Also the prefix of every D1 table the plugin owns. */
	id: string;
	version: string;
	description?: string;
	/** Plugin ids that must be set up before this one (their services are then available). */
	dependsOn?: string[];
	setup(ctx: PluginContext): void;
}

export function definePlugin(plugin: Plugin): Plugin {
	return plugin;
}
