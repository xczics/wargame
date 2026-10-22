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
 * isolates. Request #1 also pays whatever the isolate left for its first request. `--pages=地图,城池` replays only those; `--commands` sends a
 * transport and an attack after each page (see below).
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { boot, bundleModules, profiler, ROOT } from './lib/preview.mjs';

const flags = process.argv.filter((a) => a.startsWith('--'));
const args = process.argv.filter((a) => !a.startsWith('--'));
const flag = (name) =>
	flags.find((f) => f === `--${name}` || f.startsWith(`--${name}=`))?.split('=')[1] ?? (flags.includes(`--${name}`) ? '' : undefined);
const data = args[2];
if (!data) throw new Error('Usage: pnpm profile:cold <data dir> [isolates] [requests] [--pages=a,b] [--commands]');
const ISOLATES = Number(args[3] ?? 4);
const REQUESTS = Number(args[4] ?? 8);
const GM = { username: 'smoke-gm', password: 'smoke-own-password' };
// The smoke run's GM, where `vite preview` reads it (a build since then drops the file).
writeFileSync(join(ROOT, 'dist/wargame/.dev.vars'), `GM_USERNAME=${GM.username}\nGM_PASSWORD=smoke-initial-password\n`);

const first = await boot(data);
// 1. The pages' state requests and a session cookie (the session lives in the database: good for later servers too).
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
// `--commands`: commands in between, as the map page sends them (with its views): a transport to the player's own
// fortress and an attack on the NPC camp a smoke run placed by the capital (troops and supplies granted here first).
const commands = [];
if (flag('commands') !== undefined) {
	const api = async (method, path, body) => {
		const r = await page.request.fetch(first.base + path, { method, data: body, headers: { 'content-type': 'application/json' } });
		if (!r.ok()) throw new Error(`${method} ${path}: ${r.status()} ${(await r.text()).slice(0, 200)}`);
		return r.json();
	};
	const me = (await api('GET', '/api/auth/me')).user;
	const mine = (await api('GET', '/api/state?views=settlements.mine')).views['settlements.mine'];
	const capital = mine.find((s) => s.kind === 'capital') ?? mine[0];
	const fort = mine.find((s) => s.id !== capital.id);
	const wrap = (v) => ((((v + 511) % 1024) + 1024) % 1024) - 511;
	const gm = (type, payload) => api('POST', `/api/gm/players/${me.id}/command`, { type, payload });
	await gm('troops.grant', { settlement: capital.id, unit: 'infantry-1', count: 100000 });
	await gm('resources.grant', { resource: 'food', amount: 1e6 });
	const views = new URL(first.base + urls.get('地图')).search;
	if (fort)
		commands.push([
			'(transport)',
			`/api/command${views}`,
			{ type: 'armies.transport', payload: { from: capital.id, x: fort.x, y: fort.y, units: { 'infantry-1': 10 }, cargo: { food: 10 } } },
		]);
	commands.push([
		'(attack)',
		`/api/command${views}`,
		{ type: 'armies.send', payload: { from: capital.id, x: wrap(capital.x + 2), y: wrap(capital.y + 1), units: { 'infantry-1': 5 } } },
	]);
}
await browser.close();
await first.stop();
// `--pages=地图,城池`: only those pages, in turn.
const only = flag('pages')?.split(',');
const tabs = [...urls].filter(([t]) => !only || only.includes(t)).flatMap((t) => [t, ...commands]);
console.log(`Pages: ${tabs.map(([t]) => t).join(', ')}`);

// 2. Fresh isolates: each request profiled on its own.
const byIndex = Array.from({ length: REQUESTS }, () => []);
const programs = Array.from({ length: REQUESTS }, () => []);
const byTab = new Map();
// Self time by source module (the bundle's `//#region` markers) and by function, per request number, summed over isolates.
const moduleAt = bundleModules();
const modules = Array.from({ length: REQUESTS }, () => new Map());
const functions = Array.from({ length: REQUESTS }, () => new Map());
for (let round = 0; round < ISOLATES; round++) {
	const { base, stop } = await boot(data);
	const prof = await profiler();
	for (let i = 0; i < REQUESTS; i++) {
		const [tab, url, body] = tabs[i % tabs.length];
		await prof.start();
		const r = await fetch(base + url, {
			headers: { cookie, 'content-type': 'application/json' },
			...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
		});
		const answer = await r.text();
		const profile = await prof.stop();
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
		if (!r.ok) console.log(`${tab}: ${r.status} ${answer.slice(0, 200)}`);
	}
	prof.close();
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
