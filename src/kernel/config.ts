/**
 * Tunable game rules. Plugins declare them with `ctx.config.define`; a plugin providing
 * the `configStore` service persists GM overrides; the runtime resolves both into a
 * `ConfigSnapshot` that every engine call receives.
 */
import type { UiText } from '../shared/ui';
import { errorText, GameError } from './errors';
import type { Kernel } from './kernel';
import type { ConfigDefinition, ConfigSnapshot } from './types';

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
	/** Stored overrides that failed validation (the default was used instead), by key. */
	errors: Record<string, UiText>;
}

/** Merge defaults with overrides. Invalid or unknown overrides never break the game: they are reported and ignored. */
export function resolveConfig(kernel: Kernel, overrides: Record<string, unknown> = {}): ResolvedConfig {
	const values: Record<string, unknown> = {};
	const errors: Record<string, UiText> = {};
	for (const { key, def } of kernel.config.values()) {
		values[key] = def.default();
		if (!(key in overrides)) continue;
		try {
			values[key] = def.parse(overrides[key]);
		} catch (err) {
			errors[key] = errorText(err);
		}
	}
	for (const key of Object.keys(overrides)) {
		if (!kernel.config.has(key)) errors[key] = { text: 'kernel.Unknown config key "{0}"', vars: { 0: key } };
	}
	return { values, errors };
}

/** Validate a single override before storing it. Throws `GameError` for unknown keys / bad values. */
export function parseConfigValue(kernel: Kernel, key: string, raw: unknown): unknown {
	const entry = kernel.config.get(key);
	if (!entry) throw new GameError('unknown_config', 'Unknown config key "{0}"', 404, 'kernel', { 0: key });
	return entry.def.parse(raw);
}

/**
 * Load overrides via the `configStore` service if some plugin provides one. Overrides for keys
 * no plugin defines are pruned from the store (plugins are compiled in, so such a key belongs to
 * a rule that was renamed or removed); invalid values of known keys stay for the GM to fix.
 */
export async function loadConfig(kernel: Kernel, env: Env): Promise<ResolvedConfig> {
	if (!kernel.services.has('configStore')) return resolveConfig(kernel, {});
	const store = kernel.services.get('configStore');
	const overrides = await store.load(env);
	const stale = Object.keys(overrides).filter((key) => !kernel.config.has(key));
	if (stale.length && store.prune) {
		await store.prune(env, stale);
		for (const key of stale) delete overrides[key];
	}
	return resolveConfig(kernel, overrides);
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
