import { loadConfig, type EngineContext, type Kernel } from '../kernel';

// Every request reloads the rules; warn once per distinct problem instead of on every request.
let lastConfigWarning = '';

/** Build the engine context for one request: who, when, and the rules currently in force. */
export async function requestContext(kernel: Kernel, env: Env, playerId: string, privileged = false): Promise<EngineContext> {
	const { values, errors } = await loadConfig(kernel, env);
	const warning = Object.keys(errors).length ? JSON.stringify(errors) : '';
	if (warning && warning !== lastConfigWarning) console.warn('Ignoring invalid config overrides (fix them in the GM console)', errors);
	lastConfigWarning = warning;
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
