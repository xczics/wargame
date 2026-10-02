/**
 * Declarative checks of command payloads (untrusted client input). A command's `parse` is a `shape`:
 *
 *   parse: shape({ settlement: fields.id(), count: fields.int(1, 10_000), note: fields.optional(fields.text({ max: 200 })) })
 *
 * Every refusal is the kernel's own `bad_payload` error, worded once here (translated in web/core/messages.ts),
 * naming the field by its path ("units.spearman"). What only the plugin can check (a known unit, a settlement
 * of the player) stays in `execute`, through the owners' services. Forms send numbers as text: numeric strings
 * count as numbers; an empty string, null or a missing key is "missing".
 */
import type { UiText } from '../shared/ui';
import { GameError } from './errors';

/** Checks one value (its path names it in errors) and returns it typed. */
export type Field<T> = ((raw: unknown, path: string) => T) & { readonly optional?: true };

type Parsed<S extends Record<string, Field<unknown>>> = { [K in keyof S]: ReturnType<S[K]> };

const bad = (message: string, vars?: UiText['vars']) => new GameError('bad_payload', message, 400, 'kernel', vars);
const missing = (raw: unknown) => raw === undefined || raw === null || raw === '';
const numeric = (raw: unknown) => (typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw);

function required<T>(check: (raw: unknown, path: string) => T): Field<T> {
	return (raw, path) => {
		if (missing(raw)) throw bad('{0} is required', { 0: path });
		return check(raw, path);
	};
}

export const fields = {
	/** An id (a settlement's, a hero's, an item's...): 1-128 characters of letters, digits, `_ - . : @`. */
	id: (): Field<string> =>
		required((raw, path) => {
			if (typeof raw !== 'string' || !/^[\w.:@-]{1,128}$/.test(raw)) throw bad('{0} must be an id', { 0: path });
			return raw;
		}),
	/** Text, trimmed, of `min`-`max` characters. */
	text: ({ min = 1, max = 200 }: { min?: number; max?: number } = {}): Field<string> =>
		required((raw, path) => {
			const t = typeof raw === 'string' ? raw.trim() : null;
			if (t === null || t.length < min || t.length > max) throw bad('{0}: {1}-{2} characters', { 0: path, 1: min, 2: max });
			return t;
		}),
	/** A whole number from `min` to `max`. */
	int: (min: number, max: number): Field<number> =>
		required((raw, path) => {
			const n = numeric(raw);
			if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max)
				throw bad('{0} must be a whole number from {1} to {2}', { 0: path, 1: min, 2: max });
			return n;
		}),
	/** A finite number from `min` to `max`. */
	number: (min: number, max: number): Field<number> =>
		required((raw, path) => {
			const n = numeric(raw);
			if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max)
				throw bad('{0} must be a number from {1} to {2}', { 0: path, 1: min, 2: max });
			return n;
		}),
	/** true / false (also "true" / "false" and "on", as forms send checkboxes). */
	bool: (): Field<boolean> =>
		required((raw, path) => {
			if (raw === true || raw === 'true' || raw === 'on') return true;
			if (raw === false || raw === 'false') return false;
			throw bad('{0} must be true or false', { 0: path });
		}),
	/** One of `values` (a function for values known only after setup, e.g. registered unit ids). */
	oneOf: <T extends string>(values: readonly T[] | (() => readonly T[])): Field<T> =>
		required((raw, path) => {
			const all = typeof values === 'function' ? values() : values;
			if (typeof raw !== 'string' || !all.includes(raw as T)) throw bad('{0} must be one of: {1}', { 0: path, 1: all.join(', ') });
			return raw as T;
		}),
	/** A list of `min`-`max` items, each checked by `item`. */
	list: <T>(item: Field<T>, { min = 1, max = 100 }: { min?: number; max?: number } = {}): Field<T[]> =>
		required((raw, path) => {
			if (!Array.isArray(raw) || raw.length < min || raw.length > max)
				throw bad('{0} must be a list of {1}-{2} items', { 0: path, 1: min, 2: max });
			return raw.map((x, i) => item(x, `${path}[${i}]`));
		}),
	/** An object of up to `max` entries (keys from `keys`, if given), each value checked by `value`. */
	record: <T>(value: Field<T>, { keys, max = 100 }: { keys?: () => readonly string[]; max?: number } = {}): Field<Record<string, T>> =>
		required((raw, path) => {
			if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad('{0} must be an object', { 0: path });
			const entries = Object.entries(raw);
			if (entries.length > max) throw bad('{0}: at most {1} entries', { 0: path, 1: max });
			const known = keys?.();
			const out: Record<string, T> = {};
			for (const [k, v] of entries) {
				const at = `${path}.${k}`;
				if (known && !known.includes(k)) throw bad('{0} is unknown', { 0: at });
				out[k] = value(v, at);
			}
			return out;
		}),
	/** An object checked field by field (as `shape`). */
	object: <S extends Record<string, Field<unknown>>>(spec: S): Field<Parsed<S>> =>
		required((raw, path) => {
			if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw bad('{0} must be an object', { 0: path });
			return checkShape(spec, raw as Record<string, unknown>, `${path}.`);
		}),
	/** Any value, left to a check of the plugin's own (e.g. a whole definition with its validator). */
	raw: (): Field<unknown> => required((raw) => raw),
	/** Missing is fine (undefined); otherwise checked by `field`. */
	optional: <T>(field: Field<T>): Field<T | undefined> =>
		Object.assign((raw: unknown, path: string) => (missing(raw) ? undefined : field(raw, path)), { optional: true as const }),
	/** Missing gives `fallback`; otherwise checked by `field`. */
	orElse: <T>(field: Field<T>, fallback: T): Field<T> =>
		Object.assign((raw: unknown, path: string) => (missing(raw) ? fallback : field(raw, path)), { optional: true as const }),
};

function checkShape<S extends Record<string, Field<unknown>>>(spec: S, raw: Record<string, unknown>, prefix: string): Parsed<S> {
	const out: Record<string, unknown> = {};
	for (const [key, field] of Object.entries(spec)) {
		const value = field(raw[key], `${prefix}${key}`);
		if (value !== undefined) out[key] = value;
	}
	return out as Parsed<S>;
}

/** Form fields named "points.might" become `{ points: { might } }` (nested objects send their parts flat). */
function unflatten(raw: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(raw)) {
		const parts = key.split('.');
		let at = out;
		for (const part of parts.slice(0, -1)) {
			const next = at[part];
			at = at[part] = typeof next === 'object' && next !== null && !Array.isArray(next) ? { ...(next as Record<string, unknown>) } : {};
		}
		at[parts[parts.length - 1]] = value;
	}
	return out;
}

/**
 * A command's `parse` from its fields; keys the shape does not name are dropped. `refine` turns the checked
 * fields into the command's payload when they depend on each other (it may throw the plugin's own errors).
 */
export function shape<S extends Record<string, Field<unknown>>>(spec: S): (raw: unknown) => Parsed<S>;
export function shape<S extends Record<string, Field<unknown>>, R>(spec: S, refine: (fields: Parsed<S>) => R): (raw: unknown) => R;
export function shape<S extends Record<string, Field<unknown>>, R>(spec: S, refine?: (fields: Parsed<S>) => R) {
	return (raw: unknown) => {
		if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw bad('The payload must be an object');
		const parsed = checkShape(spec, unflatten((raw ?? {}) as Record<string, unknown>), '');
		return refine ? refine(parsed) : parsed;
	};
}
