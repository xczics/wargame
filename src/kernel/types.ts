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
import type { FormBudget, FormField, FormSpec } from '../shared/api';
import type { UiText } from '../shared/ui';
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
	/**
	 * The person looking is the GM (playing their own account, or in the GM console). Only for
	 * showing more (e.g. odds players do not see); it grants nothing — `privileged` does.
	 */
	gmViewer?: boolean;
	/** The rules' version (moves on with every GM change): static views are baked per version. */
	rulesVersion?: number;
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
}
export interface ReadApi extends Readonly<EngineContext> {
	readonly db: D1Database;
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
	/** Placeholders that follow another field's value, by field name (see `FormField.placeholderBy`). */
	placeholderBy?: Record<string, NonNullable<FormField['placeholderBy']>>;
	/** Replace a select's options by field name. */
	options?: Record<string, NonNullable<FormField['options']>>;
	/** Text shown above the fields (e.g. "3 / 8 outer cities built"). */
	description?: UiText;
	/** Limits checked while filling in, added to the form's (see `FormBudget`). */
	budgets?: FormBudget[];
	/** Headers of the table of fields with `cells` (see `FormSpec.columns`). */
	columns?: UiText[];
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
	/**
	 * Optional: a cheap value that changes whenever the view would (designed in, e.g. when its data was last
	 * settled; never a fingerprint of the content). The client sends back the one it holds: the same, the view is
	 * neither computed nor sent (e.g. the resource pool between production changes; the client counts on).
	 */
	stamp?(api: EngineApi, params: ViewParams): Promise<string>;
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
	views: { add(view: View): void };
	statics: { add(view: StaticView): void };
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
