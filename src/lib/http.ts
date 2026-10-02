import { GameError } from '../kernel';

export function json(data: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set('content-type', 'application/json; charset=utf-8');
	headers.set('cache-control', 'no-store');
	return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorResponse(err: unknown): Response {
	if (err instanceof GameError) {
		return json({ error: { code: err.code, message: err.message, text: err.text } }, { status: err.status });
	}
	console.error(err);
	return json({ error: { code: 'internal', message: 'Internal error' } }, { status: 500 });
}

export async function readJson(request: Request): Promise<unknown> {
	try {
		return await request.json();
	} catch {
		throw new GameError('bad_json', 'Request body must be valid JSON');
	}
}
