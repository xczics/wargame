import { loadConfig, type EngineContext, type Kernel } from '../kernel';

/** Build the engine context for one request: who, when, and the rules currently in force. */
export async function requestContext(kernel: Kernel, env: Env, playerId: string, privileged = false): Promise<EngineContext> {
	const { values, errors } = await loadConfig(kernel, env);
	if (Object.keys(errors).length) console.warn('Ignoring invalid config overrides', errors);
	return { playerId, now: Date.now(), config: values, privileged };
}

/** `?views=a,b` -> ['a', 'b']; absent -> all views. */
export function requestedViews(url: URL): string[] | undefined {
	const raw = url.searchParams.get('views');
	return raw ? raw.split(',').filter(Boolean) : undefined;
}

/** Every query parameter except `views`, handed to views (e.g. `settlement`). */
export function viewParams(url: URL): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of url.searchParams) if (k !== 'views') out[k] = v;
	return out;
}
