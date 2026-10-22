/**
 * The built Worker (`dist/wargame/index.js`) with istanbul counters on every function and statement, and
 * `GET /api/__cov[?reset=1]` answering them (workerd's inspector has no precise coverage). For `scripts/sync-counts.mjs`;
 * `restore()` puts the plain bundle back.
 */
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInstrumenter } from 'istanbul-lib-instrument';
import { ROOT } from './preview.mjs';

const EXPORT = 'export { worker_entry_default as default };';

export function instrumentBundle() {
	const file = join(ROOT, 'dist/wargame/index.js');
	const original = join(ROOT, 'dist/wargame/index.plain.js');
	copyFileSync(file, original);
	const code = readFileSync(file, 'utf8').trimEnd();
	if (!code.endsWith(EXPORT)) throw new Error('instrument: the bundle does not end with its default export');
	const out = createInstrumenter({
		esModules: true,
		coverageVariable: '__cov',
		// No `new Function` in a Worker.
		coverageGlobalScope: 'globalThis',
		coverageGlobalScopeFunc: false,
		compact: true,
	}).instrumentSync(code, 'index.js');
	const at = out.lastIndexOf('export{worker_entry_default as default}');
	if (at < 0) throw new Error('instrument: no default export after instrumenting');
	writeFileSync(
		file,
		`${out.slice(0, at)}
const __covEntry = { ...worker_entry_default, async fetch(req, env, ctx) {
	const u = new URL(req.url);
	if (u.pathname !== '/api/__cov') return worker_entry_default.fetch(req, env, ctx);
	const body = JSON.stringify(globalThis.__cov ?? null);
	if (u.searchParams.get('reset'))
		for (const f of Object.values(globalThis.__cov ?? {})) {
			for (const k of Object.keys(f.s)) f.s[k] = 0;
			for (const k of Object.keys(f.f)) f.f[k] = 0;
			for (const k of Object.keys(f.b)) f.b[k] = f.b[k].map(() => 0);
		}
	return new Response(body, { headers: { 'content-type': 'application/json' } });
} };
export { __covEntry as default };
`,
	);
	return { lines: code.split('\n'), restore: () => renameSync(original, file) };
}
