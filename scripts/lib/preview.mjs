/**
 * Fresh `vite preview` servers over the built `dist/` on a smoke run's data directory, and the V8 profiler of the
 * Worker they run (workerd's inspector): shared by `pnpm profile:cold` and `pnpm bench:local`.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
export const INSPECTOR = Number(process.env.INSPECTOR_PORT ?? 9229);

export const freePort = () =>
	new Promise((resolve) => {
		const s = createServer().listen(0, () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A new server (a new workerd, so a fresh isolate) on `data`; `stop()` ends it and everything it started. */
export async function boot(data) {
	const port = await freePort();
	const base = `http://localhost:${port}`;
	const server = spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(port), '--strictPort'], {
		cwd: ROOT,
		env: { ...process.env, WARGAME_DATA_DIR: data },
		stdio: ['ignore', 'ignore', 'inherit'],
		detached: true,
	});
	// Ready when the assets answer: they do not reach the Worker, which stays untouched until the first request.
	for (let i = 0; ; i++) {
		if (i > 120) throw new Error('The preview server did not answer');
		if (
			await fetch(`${base}/`).then(
				(r) => r.ok,
				() => false,
			)
		)
			break;
		await wait(500);
	}
	const stop = async () => {
		try {
			process.kill(-server.pid, 'SIGTERM');
		} catch {}
		await new Promise((r) => (server.exitCode !== null ? r() : server.once('exit', r)));
		// Whatever of the group outlived pnpm (vite, workerd) holds the inspector's port: gone for good.
		await wait(300);
		try {
			process.kill(-server.pid, 'SIGKILL');
		} catch {}
		await wait(300);
	};
	return { base, stop };
}

/** The Worker's V8 profiler (sampling every 50 µs): `start()`, then `stop()` gives the profile. */
export async function profiler() {
	const target = (await (await fetch(`http://localhost:${INSPECTOR}/json`)).json())[0];
	const ws = new WebSocket(target.webSocketDebuggerUrl, { headers: { origin: 'http://localhost' } });
	await new Promise((r) => (ws.onopen = r));
	let id = 0;
	const pending = new Map();
	ws.onmessage = (e) => {
		const m = JSON.parse(e.data);
		if (m.id && pending.has(m.id)) pending.get(m.id)(m.result);
	};
	const cdp = (method, params = {}) =>
		new Promise((r) => {
			pending.set(++id, r);
			ws.send(JSON.stringify({ id, method, params }));
		});
	await cdp('Profiler.enable');
	await cdp('Profiler.setSamplingInterval', { interval: 50 });
	return {
		start: () => cdp('Profiler.start'),
		stop: async () => (await cdp('Profiler.stop')).profile,
		close: () => ws.close(),
	};
}

/** The bundle's source module at a line (its `//#region` markers). */
export function bundleModules() {
	const bundle = readFileSync(join(ROOT, 'dist/wargame/index.js'), 'utf8').split('\n');
	const regions = [];
	bundle.forEach((l, i) => {
		const m = l.match(/^\/\/#region (.*)$/);
		if (m) regions.push([i, m[1]]);
	});
	return (line) => {
		let lo = 0;
		let hi = regions.length - 1;
		let ans = '?';
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			if (regions[mid][0] <= line) {
				ans = regions[mid][1];
				lo = mid + 1;
			} else hi = mid - 1;
		}
		return ans;
	};
}
