#!/usr/bin/env node
/**
 * `pnpm requests <base> [idle seconds]`: how many requests a player's browser sends to the Worker (what the free plan
 * counts), on a server started by `pnpm smoke --keep` (its throwaway database and GM). Logs in, waits on the first page
 * (default 65 s: one periodic sync), opens every tab once, goes back and reloads; for each step it prints the requests
 * that reached the Worker by path and how many the browser answered from its cache (static views, meta, terrain).
 */
import { chromium } from '@playwright/test';

const base = process.argv[2];
if (!base) {
	console.error('Usage: pnpm requests <base url> [idle seconds]');
	process.exit(1);
}
const idle = Number(process.argv[3] ?? 65) * 1000;
const browser = await chromium.launch();
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Network.enable');
let log = [];
cdp.on('Network.responseReceived', (e) => {
	const u = new URL(e.response.url);
	if (!u.pathname.startsWith('/api/')) return;
	const cached = e.response.fromDiskCache || e.response.fromPrefetchCache || e.response.fromServiceWorker;
	// Versions and ids in the path are one request kind.
	log.push({ path: u.pathname.replace(/\/[0-9a-z-]{8,}.*$/, '/…'), status: e.response.status, cached });
});
cdp.on('Network.requestServedFromCache', () => log.push({ path: '(memory cache)', cached: true }));
// Requests still in flight belong to the step that started them: wait for the network to settle.
const settle = async () => {
	await page.waitForLoadState('networkidle');
	await page.waitForTimeout(1500);
};
const step = (name) => {
	const worker = log.filter((x) => !x.cached);
	const by = {};
	for (const x of worker) by[`${x.path} ${x.status}`] = (by[`${x.path} ${x.status}`] ?? 0) + 1;
	console.log(`${name}: ${worker.length} to the Worker, ${log.length - worker.length} from the browser's cache`, by);
	log = [];
};

await page.goto(base);
await page.fill('input[autocomplete=username]', 'smoke-gm');
await page.fill('input[type=password]', 'smoke-own-password');
await page.click('button[type=submit]');
await page.waitForSelector('nav.tabs button');
await settle();
step('login + first page');
await page.waitForTimeout(idle);
step(`idle ${idle / 1000} s`);
const tabs = await page.locator('nav.tabs button').allInnerTexts();
for (const tab of tabs) {
	await page.locator('nav.tabs button', { hasText: tab }).first().click();
	await settle();
	step(`tab ${tab.trim()}`);
}
await page.locator('nav.tabs button').first().click();
await settle();
step('first tab again');
await page.reload();
await page.waitForSelector('nav.tabs button');
await settle();
step('reload');
await browser.close();
