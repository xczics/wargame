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

/** A file from elsewhere (the file bucket's public URL): no cookies, kept by the browser like any static file. */
export async function fetchFile<T>(url: string): Promise<T> {
	const res = await fetch(url, { credentials: 'omit' });
	if (!res.ok) throw new ApiError('http_error', res.statusText, res.status);
	return (await res.json()) as T;
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
	// Baked by the build into the static files (no Worker request; the browser revalidates it for free). Not there
	// under `pnpm dev`: the Worker's. Read as it comes, for the loading screen's bar.
	const baked = await fetch('/meta.json', { credentials: 'same-origin' })
		.then((r) => (r.ok && r.headers.get('content-type')?.includes('json') ? (readJson(r) as Promise<{ version: string; meta: T }>) : null))
		.catch(() => null);
	if (baked?.version) {
		holdMeta(baked.version);
		return baked.meta;
	}
	const held = heldMeta();
	const res = await fetch(held ? `/api/meta/${encodeURIComponent(held)}` : '/api/meta', { credentials: 'same-origin' });
	if (!res.ok) throw new ApiError('http_error', res.statusText, res.status);
	holdMeta(res.headers.get('x-meta-version') ?? undefined);
	return (await readJson(res)) as T;
}

/**
 * The loading screen in index.html (user 2026-11-20: "提供进度条！"): how far along starting is (0-1) and what it is
 * doing, in Chinese and English (the game's words are not here yet). Nothing once the app is up.
 */
export function bootProgress(fraction: number, zh: string, en: string) {
	(window as unknown as { __boot?: { set(f: number, zh: string, en: string): void } }).__boot?.set(fraction, zh, en);
}

/** A JSON answer read as it comes, telling the loading screen (60%-90%) how much of it is here. */
async function readJson(res: Response): Promise<unknown> {
	// Its length: the baked meta's size the build wrote into the page, else the answer's (none when compressed).
	const baked = (window as unknown as { __bootMetaBytes?: number }).__bootMetaBytes;
	const total = res.url.endsWith('/meta.json') && baked ? baked : Number(res.headers.get('content-length') ?? 0);
	if (!res.body) return res.json();
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let got = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		got += value.length;
		const kb = Math.round(got / 1024);
		const of = total ? ` / ${Math.round(total / 1024)}` : '';
		const share = total ? Math.min(1, got / total) : 1 - 1 / (1 + got / 200_000);
		bootProgress(0.6 + 0.3 * share, `读取游戏数据 ${kb}${of} KB`, `Reading the game's data ${kb}${of} KB`);
	}
	const all = new Uint8Array(got);
	let at = 0;
	for (const c of chunks) (all.set(c, at), (at += c.length));
	return JSON.parse(new TextDecoder().decode(all));
}

/** What to show for a failure: the server's text, or (no server answer) the message as it is. */
export function errorText(err: unknown): UiText {
	if (err instanceof ApiError && err.text) return err.text;
	return literal(err instanceof Error ? err.message : String(err));
}
