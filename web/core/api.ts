import type { ApiErrorBody } from '../../src/shared/api';

export class ApiError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
		/** The plugin whose translations hold the message (key "<owner>.<message>"). */
		readonly owner?: string,
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
		throw new ApiError(err?.code ?? 'http_error', err?.message ?? res.statusText, res.status, err?.owner);
	}
	return data as T;
}

let isKey = (_text: string) => false;
/** Set once the translations are known (web/core/game.ts). */
export function setKeyMatcher(match: (text: string) => boolean) {
	isKey = match;
}

/**
 * What to show for a failed request: the i18n key of a plugin's message ("<owner>.<message>"), or the message
 * itself when it already is a key (a hook's reason, e.g. "starter-army.Requires {0} Lv {1}"), else the message.
 */
export function errorText(err: unknown): string {
	if (err instanceof ApiError && err.owner && !isKey(err.message)) return `${err.owner}.${err.message}`;
	return err instanceof Error ? err.message : String(err);
}
