/**
 * Tunable game rules. Plugins declare them with `ctx.config.define`; a plugin providing
 * the `configStore` service persists GM overrides; the runtime resolves both into a
 * `ConfigSnapshot` that every engine call receives.
 */
import type { UiText } from '../shared/ui';
import { errorText, GameError } from './errors';
import type { Kernel } from './kernel';
import { PluginError } from './errors';
import type { ConfigDefinition, ConfigSnapshot, RuleView } from './types';

/** Validator for a finite number within [min, max]. */
export function numberInRange(min: number, max: number) {
	return (raw: unknown): number => {
		if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) {
			throw new GameError('bad_config', 'Expected a number between {0} and {1}', 400, 'kernel', { 0: min, 1: max });
		}
		return raw;
	};
}

export const MAX_OFFLINE_SECONDS_KEY = 'engine.maxOfflineSeconds';

/** Rules owned by the engine itself (registered by the kernel, owner "kernel"). */
export const ENGINE_CONFIG: Record<string, ConfigDefinition<unknown>> = {
	[MAX_OFFLINE_SECONDS_KEY]: {
		description: 'Offline progress cap in seconds. Time beyond this is lost.',
		default: () => 12 * 60 * 60,
		parse: numberInRange(0, 30 * 24 * 60 * 60),
	},
};

export interface ResolvedConfig {
	values: ConfigSnapshot;
	/** The stored overrides' version (0 without a store). */
	version: number;
	/** Stored overrides that failed validation (the default was used instead), by key. */
	errors: Record<string, UiText>;
}

/** Merge defaults with overrides. Invalid or unknown overrides never break the game: they are reported and ignored. */
export function resolveConfig(kernel: Kernel, overrides: Record<string, unknown> = {}): ResolvedConfig {
	const values: Record<string, unknown> = {};
	const errors: Record<string, UiText> = {};
	// Resolved on demand: a rule's default or override may read other rules (in any order, never in a cycle).
	const resolving = new Set<string>();
	const cache = cacheOf(kernel);
	const resolve = (key: string): unknown => {
		if (key in values) return values[key];
		const entry = kernel.config.get(key);
		if (!entry) return undefined;
		if (resolving.has(key)) throw new PluginError(`Config "${key}" depends on itself (through other rules)`);
		resolving.add(key);
		// Worked out again only when its own override or the rules it read changed (e.g. a table of every drop's
		// weight, built from other rules), not on every request.
		const read = new Map<string, unknown>();
		const own = ruleView(kernel, (k) => {
			const v = resolve(k);
			read.set(k, v);
			return v;
		});
		const raw = key in overrides ? JSON.stringify(overrides[key]) : '';
		const hit = cache.get(key);
		let value: unknown;
		if (hit && hit.raw === raw && [...hit.deps].every(([k, sig]) => sig === JSON.stringify(resolve(k)))) {
			value = hit.value;
			if (hit.error) errors[key] = hit.error;
		} else {
			value = entry.def.default(own);
			if (key in overrides)
				try {
					value = entry.def.parse(overrides[key], own);
				} catch (err) {
					errors[key] = errorText(err);
				}
			// Every rule, so an unchanged value stays the same object from request to request: what is built from it
			// can be kept by identity (a WeakMap) instead of being compared. (Rule values are never changed in place.)
			cache.set(key, {
				raw,
				deps: new Map([...read].map(([k, v]) => [k, JSON.stringify(v)])),
				value,
				...(errors[key] ? { error: errors[key] } : {}),
			});
		}
		resolving.delete(key);
		values[key] = value;
		return value;
	};
	for (const key of kernel.config.keys()) resolve(key);
	for (const key of Object.keys(overrides)) {
		if (!kernel.config.has(key)) errors[key] = { text: 'kernel.Unknown config key "{0}"', vars: { 0: key } };
	}
	return { values, errors, version: 0 };
}

/** Rules built from other rules, by kernel: their value, what override and which other rules' values it was for. */
const caches = new WeakMap<Kernel, Map<string, { raw: string; deps: Map<string, string>; value: unknown; error?: UiText }>>();
function cacheOf(kernel: Kernel) {
	let c = caches.get(kernel);
	if (!c) caches.set(kernel, (c = new Map()));
	return c;
}

/** Other rules as `{ config }` for handles, each resolved when first read. */
function ruleView(kernel: Kernel, resolve: (key: string) => unknown): RuleView {
	return {
		config: new Proxy({} as Record<string, unknown>, {
			get: (_t, k) => (typeof k === 'string' ? resolve(k) : undefined),
			has: (_t, k) => typeof k === 'string' && kernel.config.has(k),
		}),
	};
}

/**
 * Validate a single override before storing it. Throws `GameError` for unknown keys / bad values. `others`: the
 * other rules' current values (default: their defaults).
 */
export function parseConfigValue(kernel: Kernel, key: string, raw: unknown, others?: ConfigSnapshot): unknown {
	const entry = kernel.config.get(key);
	if (!entry) throw new GameError('unknown_config', 'Unknown config key "{0}"', 404, 'kernel', { 0: key });
	const values = others ?? resolveConfig(kernel).values;
	return entry.def.parse(raw, { config: values });
}

/**
 * The rules' version alone: one small read, nothing worked out (0 without a store). Background work that depends on
 * the rules only asks this first, and does the rest only when it moved since it last ran (keyed with `kernel.build`).
 */
export async function rulesVersion(kernel: Kernel, env: Env): Promise<number> {
	if (!kernel.services.has('configStore')) return 0;
	const store = kernel.services.get('configStore');
	return store.version ? store.version(env) : (await store.load(env)).version;
}

/** The rules this isolate last worked out, by kernel, with the store's version they are for. */
const loaded = new WeakMap<Kernel, ResolvedConfig>();

/**
 * Load overrides via the `configStore` service if some plugin provides one. Overrides for keys
 * no plugin defines are pruned from the store (plugins are compiled in, so such a key belongs to
 * a rule that was renamed or removed); invalid values of known keys stay for the GM to fix.
 *
 * Every request and background task asks; while the store's version stands (`configStore.version`, one small read)
 * the rules worked out last are the answer, the same objects. Reading every override and checking every rule against
 * them cost each request more CPU than the rest of a page's sync (2026-10-19, the free plan's 10 ms).
 */
export async function loadConfig(kernel: Kernel, env: Env): Promise<ResolvedConfig> {
	if (!kernel.services.has('configStore')) return resolveConfig(kernel, {});
	const store = kernel.services.get('configStore');
	const held = loaded.get(kernel);
	if (held && store.version && (await store.version(env)) === held.version) return held;
	const { overrides, version } = await store.load(env);
	const stale = Object.keys(overrides).filter((key) => !kernel.config.has(key));
	if (stale.length && store.prune) {
		await store.prune(env, stale);
		for (const key of stale) delete overrides[key];
	}
	const out = { ...resolveConfig(kernel, overrides), version };
	loaded.set(kernel, out);
	return out;
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
	return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

/** Validator for `{ [key]: number }` where every key must be one of `keys()` (evaluated lazily). */
export function numberRecord(keys: () => Iterable<string>, min: number, max: number) {
	const num = numberInRange(min, max);
	return (raw: unknown): Record<string, number> => {
		if (!isPlainObject(raw)) throw new GameError('bad_config', 'Expected an object of numbers');
		const known = new Set(keys());
		const out: Record<string, number> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (!known.has(k))
				throw new GameError('bad_config', 'Unknown id "{0}" (known: {1})', 400, 'kernel', { 0: k, 1: [...known].join(', ') });
			try {
				out[k] = num(v);
			} catch (err) {
				throw new GameError('bad_config', '"{0}": {1}', 400, 'kernel', { 0: k, 1: errorText(err) });
			}
		}
		return out;
	};
}

/** Validator for `{ [key]: T }` where every key must be one of `keys()`, each value checked by `value`. */
export function recordOf<T>(keys: () => Iterable<string>, value: (raw: unknown, key: string) => T) {
	return (raw: unknown): Record<string, T> => {
		if (!isPlainObject(raw)) throw new GameError('bad_config', 'Expected an object');
		const known = new Set(keys());
		const out: Record<string, T> = {};
		for (const [k, v] of Object.entries(raw)) {
			if (!known.has(k))
				throw new GameError('bad_config', 'Unknown id "{0}" (known: {1})', 400, 'kernel', { 0: k, 1: [...known].join(', ') });
			out[k] = value(v, k);
		}
		return out;
	};
}

/**
 * Validator for an object of numbers merged over `defaults` (evaluated lazily): the GM writes
 * only the fields that change, unknown fields are rejected.
 */
export function numberFields<T extends Record<string, number>>(defaults: () => T, min = 0, max = 1e12) {
	const num = numberInRange(min, max);
	return (raw: unknown): T => {
		if (!isPlainObject(raw)) throw new GameError('bad_config', 'Expected an object of numbers');
		const out: Record<string, number> = { ...defaults() };
		for (const [k, v] of Object.entries(raw)) {
			if (!(k in out))
				throw new GameError('bad_config', 'Unknown field "{0}" (known: {1})', 400, 'kernel', { 0: k, 1: Object.keys(out).join(', ') });
			out[k] = num(v);
		}
		return out as T;
	};
}

/** An error as a text inside another one's (a GameError's own key and values; anything else as it is). */
