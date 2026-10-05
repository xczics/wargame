#!/usr/bin/env node
/**
 * `pnpm profile <base> [rounds] [--bulk]`: CPU per page of the Worker, sampled by the V8 profiler (the inspector the
 * Cloudflare Vite plugin opens on :9229), on a server started by `pnpm smoke --keep` (its throwaway database and GM).
 *
 * For each page tab it records the state request the client sends, replays it `rounds` times (default 20) under the
 * profiler and prints CPU, wall time and response size per request, the modules taking the most CPU (by the bundle's
 * `//#region` markers, so build first: smoke does), and the requests themselves. `--bulk` first gives the test
 * account more heroes and troops and seeds the NPC camps. In-code timers do not help here: Workers time stands still
 * while code runs. The D1 client (`cloudflare-internal:d1-api`, `fetch`) is local overhead per query.
 */
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const base = process.argv[2];
const ROUNDS = Number(process.argv[3] ?? 20);
const GM = { username: 'smoke-gm', password: 'smoke-own-password' };

// Region map of the bundle: line -> source module.
const bundle = readFileSync('dist/wargame/index.js', 'utf8').split('\n');
const regions = [];
bundle.forEach((l, i) => {
	const m = l.match(/^\/\/#region (.*)$/);
	if (m) regions.push([i, m[1]]);
});
const moduleAt = (line) => {
	let lo = 0,
		hi = regions.length - 1,
		ans = '?';
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (regions[mid][0] <= line) {
			ans = regions[mid][1];
			lo = mid + 1;
		} else hi = mid - 1;
	}
	return ans;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const api = async (method, path, body) => {
	const r = await page.request.fetch(base + path, { method, data: body, headers: { 'content-type': 'application/json' } });
	if (!r.ok()) throw new Error(`${method} ${path}: ${r.status()} ${(await r.text()).slice(0, 200)}`);
	return r.json();
};
await page.goto(base);
await page.fill('input[autocomplete=username]', GM.username);
await page.fill('input[type=password]', GM.password);
await page.click('button[type=submit]');
await page.waitForSelector('nav.tabs button');

// Bulk the test account up a little: more heroes, more troops.
const me = (await api('GET', '/api/auth/me')).user;
const gm = (type, payload) => api('POST', `/api/gm/players/${me.id}/command`, { type, payload });
const capital = (await api('GET', '/api/state?views=settlements.mine')).views['settlements.mine'][0];
if (process.argv.includes('--bulk')) {
	const meta = await api('GET', '/api/meta');
	for (const v of meta.heroes.venues)
		for (let slot = 0; slot < 3; slot++)
			await api('POST', '/api/command', { type: 'heroes.recruit', payload: { settlement: capital.id, venue: v.id, slot } }).catch((e) =>
				console.log('recruit', e.message.slice(0, 120)),
			);
	for (const u of ['infantry-1', 'archer-1', 'cavalry-1', 'infantry-2', 'archer-2'])
		await gm('troops.grant', { settlement: capital.id, unit: u, count: 5000 }).catch((e) => console.log('troops', e.message.slice(0, 120)));
	await gm('npc-camps.populate', {}).catch((e) => console.log('populate', e.message.slice(0, 120)));
}
console.log('heroes', (await api('GET', '/api/state?views=heroes.list')).views['heroes.list'].length);

// What each page asks for: record the state requests the client sends.
const urls = new Map();
page.on('request', (r) => {
	const u = r.url();
	if (u.includes('/api/state?')) urls.set(current, u.slice(base.length));
});
let current = '';
for (const tab of await page.locator('nav.tabs button').allInnerTexts()) {
	current = tab.trim();
	await page.locator('nav.tabs button', { hasText: current }).first().click();
	await page.waitForTimeout(600);
	await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
	await page.waitForTimeout(800);
}

// CDP profiler on the Worker.
const target = (await (await fetch('http://localhost:9229/json')).json())[0];
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
await cdp('Profiler.setSamplingInterval', { interval: 100 });

const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
const rows = [];
const byModule = new Map();
for (const [tab, url] of urls) {
	await fetch(base + url, { headers: { cookie } }); // warm
	await cdp('Profiler.start');
	let bytes = 0;
	const t0 = performance.now();
	for (let i = 0; i < ROUNDS; i++) bytes += (await (await fetch(base + url, { headers: { cookie } })).text()).length;
	const wall = (performance.now() - t0) / ROUNDS;
	const { profile } = await cdp('Profiler.stop');
	const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
	const self = new Map();
	profile.samples.forEach((s, i) => self.set(s, (self.get(s) ?? 0) + (profile.timeDeltas[i] ?? 0)));
	let busy = 0;
	const mods = new Map();
	for (const [nid, us] of self) {
		const n = nodes.get(nid);
		const fn = n.callFrame.functionName;
		if (fn === '(idle)' || fn === '(program)' || fn === '(garbage collector)') {
			if (fn === '(garbage collector)') busy += us;
			continue;
		}
		busy += us;
		const mod = n.callFrame.url.includes('index.js') ? moduleAt(n.callFrame.lineNumber) : n.callFrame.url || fn;
		mods.set(mod, (mods.get(mod) ?? 0) + us);
		byModule.set(mod, (byModule.get(mod) ?? 0) + us / ROUNDS);
	}
	const top = [...mods]
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([m, us]) => `${m.replace('src/plugins/', '')} ${(us / ROUNDS / 1000).toFixed(1)}`);
	rows.push({
		tab,
		cpu: (busy / ROUNDS / 1000).toFixed(1),
		wall: wall.toFixed(1),
		kb: (bytes / ROUNDS / 1024).toFixed(1),
		top: top.slice(0, 3).join(' | '),
	});
}
console.table(rows);
console.log('Top modules (ms per request, summed over pages):');
for (const [m, us] of [...byModule].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${(us / 1000).toFixed(2).padStart(7)}  ${m}`);
for (const [tab, url] of urls) console.log(tab, decodeURIComponent(url).slice(0, 300));
ws.close();
await browser.close();
