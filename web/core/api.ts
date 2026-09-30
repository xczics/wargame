import type { ApiErrorBody } from '../../src/shared/api';

export class ApiError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status: number,
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
		throw new ApiError(err?.code ?? 'http_error', err?.message ?? res.statusText, res.status);
	}
	return data as T;
}
