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
import type { FormField, FormSpec } from '../shared/api';
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
	/** Raw (unvalidated) overrides by full config key. */
	load(env: Env): Promise<Record<string, unknown>>;
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
}

/** What views and reports receive: read-only access to the database. */
export interface ReadApi extends Readonly<EngineContext> {
	readonly db: D1Database;
	services: ServiceLookup;
	/**
	 * Per-call cache: the first caller runs `load`, later callers in the same command/view
	 * pass get the same promise. Use it so several plugins can share loaded rows.
	 */
	memo<T>(key: string, load: () => Promise<T>): Promise<T>;
}

/** What commands receive: reads plus a write queue that commits atomically. */
export interface EngineApi extends ReadApi {
	/** Queue statements. Nothing is written until the command finishes; then all writes commit in one batch. */
	write(...statements: D1PreparedStatement[]): void;
	/**
	 * Run `fn` once just before commit (deduplicated by `key`). Use it to flush state a
	 * plugin accumulated in memory during the command (e.g. settled resource balances).
	 */
	beforeCommit(key: string, fn: () => void | Promise<void>): void;
	/**
	 * Add an entity to this command's optimistic lock set (the acting player is always
	 * included). Call it BEFORE reading that entity's rows. If anyone else commits a
	 * change to a locked entity in the meantime, the whole command is retried.
	 */
	lock(entity: string): Promise<void>;
}

/**
 * A tunable game rule. GMs can override it at runtime; overrides take effect on the
 * next engine call for every player (including their unsettled offline time).
 */
export interface ConfigDefinition<T> {
	description: string;
	/** Default value. A function is evaluated lazily, so it may depend on content defined by later plugins. */
	default: () => T;
	/** Validate an override (untrusted: comes from storage / the GM UI). Throw `GameError` with a helpful message. */
	parse(raw: unknown): T;
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

export interface CommandForm extends FormSpec {
	/**
	 * Decide whether the form is available right now (return `false` to hide it) and fill
	 * in dynamic parts. Runs in dry-run mode, like a view. Default: always shown.
	 */
	prepare?(api: EngineApi, params: ViewParams): Promise<false | FormPatch>;
}

export interface FormPatch {
	/** Extra fields known only at runtime (e.g. one number per unit type), appended to the form's. */
	fields?: FormField[];
	/** Default values by field name (e.g. the current settlement id for a hidden field). */
	defaults?: Record<string, string | number | boolean>;
	/** Replace a select's options by field name. */
	options?: Record<string, NonNullable<FormField['options']>>;
	/** Text shown above the fields (e.g. "3 / 8 outer cities built"). */
	description?: string;
}

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
}

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
}

/** Static game data served at /api/meta (content definitions etc.). */
export type MetaProvider = () => unknown;

export interface ServiceLookup {
	get<K extends keyof ServiceMap>(name: K): ServiceMap[K];
	has(name: string): boolean;
}

export interface PluginContext {
	readonly pluginId: string;
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
	views: { add(view: View): void };
	reports: { add(report: Report): void };
	tasks: { add(task: Task): void };
	routes: { add(route: Route): void };
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
