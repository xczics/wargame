import type { ApiErrorBody } from '../../src/shared/api';
import { literal } from '../../src/shared/i18n';
import type { UiText } from '../../src/shared/ui';

export class ApiError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
		/** What to show (the server's text: a key and its values). */
		readonly text?: UiText,
	) {
		super(message);
		this.name = 'ApiError';
	}
}

export interface RequestOptions {
	method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
	body?: unknown;
}

/** JSON request to the Worker. Throws `ApiError` with the server's error code on failure. */
export async function request<T>(path: string, { method = 'GET', body }: RequestOptions = {}): Promise<T> {
	const res = await fetch(path, {
		method,
		credentials: 'same-origin',
		headers: body === undefined ? {} : { 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) {
		const err = (data as Partial<ApiErrorBody>).error;
		throw new ApiError(err?.code ?? 'http_error', err?.message ?? res.statusText, res.status, err?.text);
	}
	return data as T;
}

const META_KEY = 'wargame.metaVersion';
const heldMeta = () => {
	try {
		return localStorage.getItem(META_KEY);
	} catch {
		return null;
	}
};
/** Remember the meta's current version (from a load or a sync): the next page load takes it from the browser's cache. */
export function holdMeta(version: string | undefined) {
	if (!version || version === heldMeta()) return;
	try {
		localStorage.setItem(META_KEY, version);
	} catch {
		// Private windows and the like: the meta is asked for on every load, as before.
	}
}
/**
 * The meta: by the version this browser holds (kept by its HTTP cache for good, so no request reaches the Worker),
 * else the current one; the answer says which version it is.
 */
export async function loadMeta<T>(): Promise<T> {
	const held = heldMeta();
	const res = await fetch(held ? `/api/meta/${encodeURIComponent(held)}` : '/api/meta', { credentials: 'same-origin' });
	if (!res.ok) throw new ApiError('http_error', res.statusText, res.status);
	holdMeta(res.headers.get('x-meta-version') ?? undefined);
	return (await res.json()) as T;
}

/** What to show for a failure: the server's text, or (no server answer) the message as it is. */
export function errorText(err: unknown): UiText {
	if (err instanceof ApiError && err.text) return err.text;
	return literal(err instanceof Error ? err.message : String(err));
}
