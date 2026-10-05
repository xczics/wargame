/**
 * Static views (`ctx.statics`): baked once per rules version into the static store, sent to clients by version.
 *
 * - The store is a service (`staticStore`): by default this isolate's memory; a plugin may provide object storage
 *   (e.g. R2) instead, so baked views live outside the database and can be served from there.
 * - A manifest (also in the store) lists each static view's version and the rules it read, with a signature of
 *   their values when baked. When the rules' version moves on (a GM change), only the views whose rules changed are
 *   baked again; a new build bakes them all.
 * - All of this happens once per rules version per isolate (and once per change in the store), never per request:
 *   a request only reads the manifest this isolate keeps.
 */
import type { Kernel, RuleView } from '../kernel';
import pkg from '../../package.json';

export interface StaticStore {
	get(key: string): Promise<string | null>;
	put(key: string, body: string): Promise<void>;
}

declare module '../kernel' {
	interface ServiceMap {
		staticStore: StaticStore;
	}
}

const memory = new Map<string, string>();
/** The default store: this isolate's memory (baked again on a cold start). */
export const memoryStore: StaticStore = {
	get: async (key) => memory.get(key) ?? null,
	put: async (key, body) => void memory.set(key, body),
};
const storeOf = (kernel: Kernel) => (kernel.services.has('staticStore') ? kernel.services.get('staticStore') : memoryStore);

/** What code the views were baked by: a new deploy bakes them all again. */
const buildOf = (kernel: Kernel) => `${pkg.version}|${kernel.plugins.map((p) => `${p.id}@${p.version}`).join(',')}`;

interface Manifest {
	build: string;
	rules: number;
	/** By static view: its version, and the rules it read with a signature of their values then. */
	items: Record<string, { version: string; deps: Record<string, string> }>;
}
const MANIFEST = 'static/manifest.json';
export const staticKey = (id: string, version: string) => `static/${id}/${version}.json`;

/** FNV-1a: a short signature of a JSON text (at baking only). */
function sign(text: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
	return `${(h >>> 0).toString(36)}${text.length.toString(36)}`;
}

const known = new WeakMap<Kernel, Manifest>();
const baking = new WeakMap<Kernel, Promise<Manifest>>();

/**
 * The static views' versions for these rules (by id). Bakes what is missing or out of date first: on the first
 * request of an isolate (from the stored manifest) and after a rules change; otherwise from memory.
 */
export async function staticVersions(
	kernel: Kernel,
	env: Env,
	rules: { values: Readonly<Record<string, unknown>>; version: number },
): Promise<Record<string, string>> {
	if (!kernel.statics.length) return {};
	const build = buildOf(kernel);
	let m = known.get(kernel);
	if (!m || m.build !== build || m.rules !== rules.version) {
		let running = baking.get(kernel);
		if (!running) {
			running = bake(kernel, env, rules, build).finally(() => baking.delete(kernel));
			baking.set(kernel, running);
		}
		m = await running;
		known.set(kernel, m);
	}
	return Object.fromEntries(Object.entries(m.items).map(([id, x]) => [id, x.version]));
}

const ruleView = (values: Readonly<Record<string, unknown>>, read: Set<string>): RuleView => ({
	config: new Proxy({} as Record<string, unknown>, {
		get: (_t, k) => {
			if (typeof k !== 'string') return undefined;
			read.add(k);
			return values[k];
		},
		has: (_t, k) => typeof k === 'string' && k in values,
	}),
});

async function bake(
	kernel: Kernel,
	env: Env,
	rules: { values: Readonly<Record<string, unknown>>; version: number },
	build: string,
): Promise<Manifest> {
	const store = storeOf(kernel);
	const stored = await store.get(MANIFEST).then((t) => (t ? (JSON.parse(t) as Manifest) : null));
	const before = stored && stored.build === build ? stored : null;
	if (before && before.rules === rules.version && kernel.statics.every((s) => before.items[s.id])) return before;
	const items: Manifest['items'] = {};
	for (const s of kernel.statics) {
		const was = before?.items[s.id];
		// Unchanged rules underneath: the baked one stands.
		if (was && Object.entries(was.deps).every(([k, sig]) => sign(JSON.stringify(rules.values[k]) ?? '') === sig)) {
			items[s.id] = was;
			continue;
		}
		const read = new Set<string>();
		const body = JSON.stringify(await s.compute({ rules: ruleView(rules.values, read), db: env.DB }));
		const version = sign(body);
		await store.put(staticKey(s.id, version), body);
		items[s.id] = { version, deps: Object.fromEntries([...read].map((k) => [k, sign(JSON.stringify(rules.values[k]) ?? '')])) };
	}
	const manifest: Manifest = { build, rules: rules.version, items };
	await store.put(MANIFEST, JSON.stringify(manifest));
	return manifest;
}

/** A baked static view's body, or null (an old version no longer kept, or unknown). */
export async function staticBody(kernel: Kernel, id: string, version: string): Promise<string | null> {
	return storeOf(kernel).get(staticKey(id, version));
}
