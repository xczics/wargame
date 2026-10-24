#!/usr/bin/env node
/**
 * After `vite build`: bake the meta (`ctx.meta.add`, which depends only on the code and content) into the client's
 * static files as dist/client/meta.json, so browsers load it as a static asset (free, no Worker request) instead of
 * from /api/meta. The server code runs here under Vite's SSR loader (CSV `?raw` imports, import.meta.glob), through
 * the same buildMeta as the Worker, so the version matches what /api/state reports.
 *
 * `--version` (before `vite build`): only the version, into src/runtime/meta.generated.json, which the Worker bundles:
 * every state and command response carries it, and working the 470 KB meta out to learn it cost each new isolate's
 * first request several ms (2026-10-20: production isolates serve ~8 requests each). The run after the build checks
 * the meta it bakes has that version and removes the file, so dev servers and tests work it out themselves.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
	const { staticFingerprints } = await server.ssrLoadModule('/src/runtime/statics.ts');
	const kernel = createKernel(plugins);
	const { body, version } = await buildMeta(kernel);
	const generated = new URL('../src/runtime/meta.generated.json', import.meta.url);
	if (process.argv.includes('--version')) {
		// And each static view's fingerprint: a deploy bakes again only those its code changed (src/runtime/statics.ts).
		const statics = await staticFingerprints(kernel);
		writeFileSync(generated, `${JSON.stringify({ version, statics })}\n`);
		console.log(`meta version ${version} and ${Object.keys(statics).length} static views' fingerprints for the Worker`);
	} else {
		if (existsSync(generated)) {
			const bundled = JSON.parse(readFileSync(generated, 'utf8')).version;
			rmSync(generated);
			if (bundled !== version) throw new Error(`The Worker was built with meta ${bundled}, the meta is ${version}`);
		}
		writeFileSync(new URL('../dist/client/meta.json', import.meta.url), `{"version":${JSON.stringify(version)},"meta":${body}}`);
		console.log(`meta ${version} baked into dist/client/meta.json (${Math.round(body.length / 1024)} KB)`);
	}
} finally {
	await server.close();
}
