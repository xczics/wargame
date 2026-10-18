/**
 * The meta (`ctx.meta.add`): static game data that depends only on the deploy (code and content), never on GM rules.
 * The Worker serves it at /api/meta; the build bakes the same body into the client's static files (meta.json, see
 * scripts/bake-meta.mjs), so browsers load it without a Worker request. Both use this function, so the versions match.
 */
import type { Kernel } from '../kernel';

export interface MetaFile {
	body: string;
	version: string;
}

export async function buildMeta(kernel: Kernel): Promise<MetaFile> {
	const meta: Record<string, unknown> = {};
	for (const [key, provider] of kernel.meta) meta[key] = provider();
	const body = JSON.stringify({
		plugins: kernel.plugins.map((p) => ({ id: p.id, version: p.version, description: p.description })),
		...meta,
	});
	const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
	return { body, version: [...digest.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('') };
}
