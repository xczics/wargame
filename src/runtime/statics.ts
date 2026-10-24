/**
 * Static views (`ctx.statics`): baked once per rules version into the static store, sent to clients by version.
 *
 * - The store is a service (`staticStore`): by default this isolate's memory; a plugin may provide object storage
 *   (e.g. R2) instead, so baked views live outside the database and can be served from there.
 * - A manifest (also in the store) lists each static view's version and the rules it read, with a signature of
 *   their values when baked. When the rules' version moves on (a GM change), only the views whose rules changed are
 *   baked again. A new build bakes again only the views its code changed: the build works each one out with the
 *   default rules and bundles a fingerprint of it (`staticFingerprints`, scripts/bake-meta.mjs); one whose fingerprint
 *   is the same is kept, and a body that comes out the same is not written again (user 2026-10-24: "每次部署只调一小部分，
 *   但每次都重新烘焙、更新全部静态文件？"). Views of content tables (`content`) are baked again with every build.
 * - All of this happens once per rules version per isolate (and once per change in the store), never per request:
 *   a request only reads the manifest this isolate keeps.
 */
import { resolveConfig, type Kernel, type RuleView } from '../kernel';
import { envFiles } from './files';

/**
 * Each static view's fingerprint the build worked out (`scripts/bake-meta.mjs --version`); none in dev servers and
 * tests, where a new build bakes them all as before.
 */
const bakedFingerprints: Record<string, string> | undefined = Object.values(
	import.meta.glob<{ statics?: Record<string, string> }>('./meta.generated.json', { eager: true, import: 'default' }),
)[0]?.statics;

/** Each static view (not of content tables) worked out with the default rules, signed: what its code makes of them. */
export async function staticFingerprints(kernel: Kernel): Promise<Record<string, string>> {
	const values = resolveConfig(kernel, {}).values;
	const out: Record<string, string> = {};
	for (const s of kernel.statics)
		if (!s.content) out[s.id] = sign(JSON.stringify(await s.compute({ rules: ruleView(values, new Set()), db: null as never })));
	return out;
}

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
/** A plugin's store first, then the FILES bucket, else this isolate's memory. */
function storeOf(kernel: Kernel, env: Env): StaticStore {
	if (kernel.services.has('staticStore')) return kernel.services.get('staticStore');
	const files = envFiles(env);
	if (!files) return memoryStore;
	// Baked views never change (their key carries the version); the manifest does.
	return {
		get: (key) => files.get(key),
		put: (key, body) =>
			files.put(key, body, {
				contentType: 'application/json; charset=utf-8',
				cacheControl: key === MANIFEST ? 'no-cache' : 'public, max-age=31536000, immutable',
			}),
	};
}

/** What code the views were baked by: a new deploy bakes them all again. */

interface Manifest {
	build: string;
	rules: number;
	/** By static view: its version, and the rules it read with a signature of their values then. */
	items: Record<string, { version: string; deps: Record<string, string>; fingerprint?: string }>;
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
	/** (Tests: what a build would have bundled.) */
	fingerprints: Record<string, string> | undefined = bakedFingerprints,
): Promise<Record<string, string>> {
	if (!kernel.statics.length) return {};
	const build = kernel.build;
	let m = known.get(kernel);
	if (!m || m.build !== build || m.rules !== rules.version) {
		let running = baking.get(kernel);
		if (!running) {
			running = bake(kernel, env, rules, build, fingerprints).finally(() => baking.delete(kernel));
			baking.set(kernel, running);
		}
		m = await running;
		known.set(kernel, m);
	}
	return versionsOf(m).versions;
}

/** A manifest's versions by id, and one version for them all (the browser sends it back: the same, they are not sent). */
const listed = new WeakMap<Manifest, { versions: Record<string, string>; version: string }>();
function versionsOf(m: Manifest) {
	let v = listed.get(m);
	if (!v) {
		const versions = Object.fromEntries(Object.entries(m.items).map(([id, x]) => [id, x.version]));
		listed.set(m, (v = { versions, version: sign(JSON.stringify(versions)) }));
	}
	return v;
}
/** `staticVersions`, with the one version for them all. */
export async function staticsList(
	kernel: Kernel,
	env: Env,
	rules: { values: Readonly<Record<string, unknown>>; version: number },
): Promise<{ versions: Record<string, string>; version: string }> {
	const versions = await staticVersions(kernel, env, rules);
	const m = known.get(kernel);
	return m ? versionsOf(m) : { versions, version: sign(JSON.stringify(versions)) };
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
	fingerprints: Record<string, string> | undefined,
): Promise<Manifest> {
	const store = storeOf(kernel, env);
	const stored = await store.get(MANIFEST).then((t) => (t ? (JSON.parse(t) as Manifest) : null));
	if (stored && stored.build === build && stored.rules === rules.version && kernel.statics.every((s) => stored.items[s.id])) return stored;
	const items: Manifest['items'] = {};
	for (const s of kernel.statics) {
		const was = stored?.items[s.id];
		const fingerprint = fingerprints?.[s.id];
		// The same code (its fingerprint, or the same build where the build has none) and the same rules underneath: the
		// baked one stands. Views of content tables are baked again with every build and rules version.
		const sameCode = fingerprint !== undefined ? was?.fingerprint === fingerprint : stored?.build === build;
		if (
			was &&
			!s.content &&
			sameCode &&
			Object.entries(was.deps).every(([k, sig]) => sign(JSON.stringify(rules.values[k]) ?? '') === sig)
		) {
			items[s.id] = was;
			continue;
		}
		const read = new Set<string>();
		const body = JSON.stringify(await s.compute({ rules: ruleView(rules.values, read), db: env.DB }));
		const version = sign(body);
		// The same body as before (named by its content): already stored.
		if (version !== was?.version) await store.put(staticKey(s.id, version), body);
		items[s.id] = {
			version,
			deps: Object.fromEntries([...read].map((k) => [k, sign(JSON.stringify(rules.values[k]) ?? '')])),
			...(fingerprint !== undefined ? { fingerprint } : {}),
		};
	}
	const manifest: Manifest = { build, rules: rules.version, items };
	await store.put(MANIFEST, JSON.stringify(manifest));
	return manifest;
}

/** A baked static view's body, or null (an old version no longer kept, or unknown). */
export async function staticBody(kernel: Kernel, env: Env, id: string, version: string): Promise<string | null> {
	return storeOf(kernel, env).get(staticKey(id, version));
}
