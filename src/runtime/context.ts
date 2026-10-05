import type { ViewInstance } from '../shared/api';
import { loadConfig, type EngineContext, type Kernel } from '../kernel';

// Every request reloads the rules; warn once per distinct problem instead of on every request.
let lastConfigWarning = '';

/** Build the engine context for one request: who, when, and the rules currently in force. */
export async function requestContext(
	kernel: Kernel,
	env: Env,
	playerId: string,
	privileged = false,
	gmViewer = privileged,
): Promise<EngineContext> {
	const { values, errors, version } = await loadConfig(kernel, env);
	const warning = Object.keys(errors).length ? JSON.stringify(errors) : '';
	if (warning && warning !== lastConfigWarning) console.warn('Ignoring invalid config overrides (fix them in the GM console)', errors);
	lastConfigWarning = warning;
	return { playerId, now: Date.now(), config: values, privileged, gmViewer, rulesVersion: version };
}

/** `?views=a,b` -> ['a', 'b']; absent -> all views. */
export function requestedViews(url: URL): string[] | undefined {
	const raw = url.searchParams.get('views');
	return raw ? raw.split(',').filter(Boolean) : undefined;
}

/** Every query parameter except `views` and `instances`, handed to views (e.g. `settlement`). */
export function viewParams(url: URL): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of url.searchParams) if (k !== 'views' && k !== 'instances' && k !== 'stamps') out[k] = v;
	return out;
}

/** `stamps`: what the client holds of views with a stamp, { "<view>": stamp } (untrusted: anything odd is left out). */
export function requestedStamps(url: URL): Record<string, string> {
	const raw = url.searchParams.get('stamps');
	if (!raw || raw.length > 4000) return {};
	try {
		const v = JSON.parse(raw) as unknown;
		if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
		return Object.fromEntries(Object.entries(v).filter(([k, s]) => typeof s === 'string' && k.length <= 200));
	} catch {
		return {};
	}
}

/** `instances`: a JSON list of { key, view, params } (untrusted: anything malformed is left out; at most 32). */
export function requestedInstances(url: URL): ViewInstance[] {
	const raw = url.searchParams.get('instances');
	if (!raw) return [];
	let list: unknown;
	try {
		list = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(list)) return [];
	const out: ViewInstance[] = [];
	for (const x of list.slice(0, 32)) {
		const i = x as Partial<ViewInstance>;
		if (typeof i?.key !== 'string' || i.key.length > 500 || typeof i.view !== 'string' || typeof i.params !== 'object' || !i.params)
			continue;
		const params = Object.fromEntries(
			Object.entries(i.params).filter(([k, v]) => typeof v === 'string' && k !== 'views' && k !== 'instances'),
		) as Record<string, string>;
		out.push({ key: i.key, view: i.view, params });
	}
	return out;
}
