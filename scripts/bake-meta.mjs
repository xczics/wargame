#!/usr/bin/env node
/**
 * After `vite build`: bake the meta (`ctx.meta.add`, which depends only on the code and content) into the client's
 * static files as dist/client/meta.json, so browsers load it as a static asset (free, no Worker request) instead of
 * from /api/meta. The server code runs here under Vite's SSR loader (CSV `?raw` imports, import.meta.glob), through
 * the same buildMeta as the Worker, so the version matches what /api/state reports.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const server = await createServer({
	root,
	configFile: false,
	logLevel: 'error',
	appType: 'custom',
	server: { middlewareMode: true, hmr: false, watch: null },
	optimizeDeps: { noDiscovery: true, include: [] },
});
try {
	const { createKernel } = await server.ssrLoadModule('/src/kernel/index.ts');
	const { plugins } = await server.ssrLoadModule('/src/plugins.ts');
	const { buildMeta } = await server.ssrLoadModule('/src/runtime/meta.ts');
	const { body, version } = await buildMeta(createKernel(plugins));
	writeFileSync(new URL('../dist/client/meta.json', import.meta.url), `{"version":${JSON.stringify(version)},"meta":${body}}`);
	console.log(`meta ${version} baked into dist/client/meta.json (${Math.round(body.length / 1024)} KB)`);
} finally {
	await server.close();
}
