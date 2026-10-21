#!/usr/bin/env node
/**
 * `pnpm profile:cold <data dir> [isolates] [requests]`: CPU of the first requests a fresh Worker isolate serves, the way
 * production runs (an isolate there serves only a handful of requests: its code mostly runs before V8 has optimised it,
 * which the warm replays of `pnpm profile` hide).
 *
 * Takes the data directory a `pnpm smoke --keep` run printed (stop that server first: this one starts its own
 * `vite preview` on it, over the built `dist/`). It logs in once in a browser to record each page's state request, then
 * `isolates` times (default 4) starts a fresh server and replays `requests` state requests (default 8: the pages in
 * turn), each under the V8 profiler on its own, and prints the CPU of request #1, #2, … and per page, medians over the
 * isolates. Request #1 also pays whatever the isolate left for its first request.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = process.argv[2];
if (!data) throw new Error('Usage: pnpm profile:cold <data dir> [isolates] [requests]');
const ISOLATES = Number(process.argv[3] ?? 4);
const REQUESTS = Number(process.argv[4] ?? 8);
const GM = { username: 'smoke-gm', password: 'smoke-own-password' };
const INSPECTOR = Number(process.env.INSPECTOR_PORT ?? 9229);

const freePort = () =>
	new Promise((resolve) => {
		const s = createServer().listen(0, () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
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
		await wait(500);
	};
	return { base, stop };
}

// 1. The pages' state requests and a session cookie (the session lives in the database: good for later servers too).
const first = await boot();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
await page.goto(first.base);
await page.fill('input[autocomplete=username]', GM.username);
await page.fill('input[type=password]', GM.password);
await page.click('button[type=submit]');
await page.waitForSelector('nav.tabs button');
const urls = new Map();
let current = '';
page.on('request', (r) => {
	const u = r.url();
	if (u.includes('/api/state?')) urls.set(current, u.slice(first.base.length));
});
for (const tab of await page.locator('nav.tabs button').allInnerTexts()) {
	current = tab.trim();
	await page.locator('nav.tabs button', { hasText: current }).first().click();
	await page.waitForTimeout(600);
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await page.waitForTimeout(800);
}
const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
await browser.close();
await first.stop();
const tabs = [...urls];
console.log(`Pages: ${tabs.map(([t]) => t).join(', ')}`);

// 2. Fresh isolates: each request profiled on its own.
const byIndex = Array.from({ length: REQUESTS }, () => []);
const programs = Array.from({ length: REQUESTS }, () => []);
const byTab = new Map();
// Self time by source module (the bundle's `//#region` markers) and by function, per request number, summed over isolates.
const bundle = readFileSync(join(ROOT, 'dist/wargame/index.js'), 'utf8').split('\n');
const regions = [];
bundle.forEach((l, i) => {
	const m = l.match(/^\/\/#region (.*)$/);
	if (m) regions.push([i, m[1]]);
});
const moduleAt = (line) => {
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
const modules = Array.from({ length: REQUESTS }, () => new Map());
const functions = Array.from({ length: REQUESTS }, () => new Map());
for (let round = 0; round < ISOLATES; round++) {
	const { base, stop } = await boot();
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
	for (let i = 0; i < REQUESTS; i++) {
		const [tab, url] = tabs[i % tabs.length];
		await cdp('Profiler.start');
		const r = await fetch(base + url, { headers: { cookie } });
		await r.text();
		const { profile } = await cdp('Profiler.stop');
		const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
		// "(program)" is V8 outside JavaScript (compiling, parsing): on a fresh isolate much of the cost, and billed.
		let busy = 0;
		let program = 0;
		profile.samples.forEach((s, k) => {
			const fn = nodes.get(s).callFrame.functionName;
			if (fn === '(program)') program += profile.timeDeltas[k] ?? 0;
			else if (fn !== '(idle)') busy += profile.timeDeltas[k] ?? 0;
		});
		busy += program;
		profile.samples.forEach((s, k) => {
			const f = nodes.get(s).callFrame;
			if (f.functionName === '(idle)') return;
			const mod = f.url.includes('index.js') ? moduleAt(f.lineNumber) : f.url || f.functionName;
			modules[i].set(mod, (modules[i].get(mod) ?? 0) + (profile.timeDeltas[k] ?? 0) / 1000 / ISOLATES);
			const fn = `${f.functionName || '(anonymous)'} ${mod.replace('src/', '')}:${f.lineNumber}`;
			functions[i].set(fn, (functions[i].get(fn) ?? 0) + (profile.timeDeltas[k] ?? 0) / 1000 / ISOLATES);
		});
		programs[i].push(program / 1000);
		byIndex[i].push(busy / 1000);
		if (!byTab.has(tab)) byTab.set(tab, []);
		byTab.get(tab).push({ i, ms: busy / 1000 });
		if (!r.ok) console.log(`${tab}: ${r.status}`);
	}
	ws.close();
	await stop();
}
const median = (a) => {
	const s = [...a].sort((x, y) => x - y);
	return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
console.table(
	byIndex.map((a, i) => ({
		request: i + 1,
		page: tabs[i % tabs.length][0],
		median: median(a).toFixed(1),
		program: median(programs[i]).toFixed(1),
		all: a.map((x) => x.toFixed(1)).join(' '),
	})),
);
const all = byIndex.flat();
const rest = byIndex.slice(1).flat();
const top = (m, n) =>
	[...m]
		.sort((a, b) => b[1] - a[1])
		.slice(0, n)
		.map(([k, ms]) => `  ${ms.toFixed(2).padStart(6)}  ${k}`)
		.join('\n');
const later = new Map();
for (const m of modules.slice(1)) for (const [k, ms] of m) later.set(k, (later.get(k) ?? 0) + ms / (REQUESTS - 1 || 1));
const laterFns = new Map();
for (const m of functions.slice(1)) for (const [k, ms] of m) laterFns.set(k, (laterFns.get(k) ?? 0) + ms / (REQUESTS - 1 || 1));
console.log(`Request #1, by module (ms):\n${top(modules[0], 20)}`);
console.log(`Request #1, by function (ms):\n${top(functions[0], 25)}`);
if (REQUESTS > 1) console.log(`Requests #2-#${REQUESTS}, by module (ms per request):\n${top(later, 20)}`);
if (REQUESTS > 1) console.log(`Requests #2-#${REQUESTS}, by function (ms per request):\n${top(laterFns, 25)}`);
console.log(`Median over all requests: ${median(all).toFixed(1)} ms; without request #1: ${median(rest).toFixed(1)} ms`);
