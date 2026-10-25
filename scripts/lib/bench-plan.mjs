/**
 * What `pnpm bench:local` and `scripts/bench-online.mjs` send to the bench routes (src/plugins/bench): one address
 * per phase, labelled (`_bench=`) so the CPU each one took can be grouped by label afterwards, locally from the V8
 * profiler and online from `wrangler tail` (scripts/bench-tail.mjs).
 */
import { chromium } from '@playwright/test';

/** A page's state query as a first visit sends it: no stamps held, no record to check against. */
function firstVisit(search) {
	const q = new URLSearchParams(search);
	q.delete('stamps');
	q.delete('sync');
	const instances = q.get('instances');
	if (instances)
		try {
			q.set('instances', JSON.stringify(JSON.parse(instances).map(({ stamp: _, ...rest }) => rest)));
		} catch {}
	return q.toString();
}

/**
 * Each page's state query (label: the tab's text), recorded in a browser logged in with `cookie` (`name=value`) by
 * clicking every tab, as `pnpm profile:cold` does.
 */
export async function capturePages(base, cookie) {
	const browser = await chromium.launch();
	const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
	const [name, ...rest] = cookie.split('=');
	await context.addCookies([{ name: name.trim(), value: rest.join('=').trim(), url: base }]);
	const page = await context.newPage();
	const pages = new Map();
	let current = '';
	page.on('request', (r) => {
		const u = new URL(r.url());
		if (u.pathname === '/api/state' && current && !pages.has(current)) pages.set(current, firstVisit(u.search));
	});
	await page.goto(base);
	await page.waitForSelector('nav.tabs button', { timeout: 30_000 });
	for (const tab of await page.locator('nav.tabs button').allInnerTexts()) {
		current = tab.trim();
		await page.locator('nav.tabs button', { hasText: current }).first().click();
		await page.waitForTimeout(800);
		await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
		await page.waitForTimeout(800);
	}
	await browser.close();
	return pages;
}

/**
 * The requests, in order: `[label, method, path, body?]`. `target`: a construct payload (`/api/_bench/target`), or
 * null when the player has nothing to upgrade (the command addresses are left out then).
 */
export function benchPlan(pages, target) {
	const label = (path, name) => `${path}${path.includes('?') ? '&' : '?'}_bench=${encodeURIComponent(name)}`;
	const out = [
		['timers', 'GET', label('/api/_bench/timers?n=20000000', 'timers')],
		['noop', 'GET', label('/api/_bench/noop', 'noop')],
		['d1 seq 1', 'GET', label('/api/_bench/d1?n=1&mode=seq', 'd1 seq 1')],
		['d1 seq 10', 'GET', label('/api/_bench/d1?n=10&mode=seq', 'd1 seq 10')],
		['d1 batch 10', 'GET', label('/api/_bench/d1?n=10&mode=batch', 'd1 batch 10')],
		['d1 pack 10', 'GET', label('/api/_bench/d1?n=10&mode=pack', 'd1 pack 10')],
		['d1 batch 40', 'GET', label('/api/_bench/d1?n=40&mode=batch', 'd1 batch 40')],
		['assemble', 'GET', label('/api/_bench/assemble', 'assemble')],
		['assemble+rules', 'GET', label('/api/_bench/assemble?rules=1', 'assemble+rules')],
		['upgrade file', 'GET', label('/api/_bench/upgrade', 'upgrade file')],
	];
	for (const [page, query] of pages) {
		out.push([`sync ${page}`, 'GET', label(`/api/_bench/sync?${query}`, `sync ${page}`)]);
		out.push([`state ${page}`, 'GET', label(`/api/state?${query}`, `state ${page}`)]);
	}
	if (target) {
		const payload = { settlement: target.settlement, district: target.district, slot: target.slot };
		// The command as the city page sends it: its views after it.
		const city = [...pages].find(([, q]) => q.includes('buildings.')) ?? [...pages][0];
		out.push(['real construct', 'POST', label('/api/_bench/real/buildings.construct', 'real construct'), payload]);
		if (city)
			out.push([
				`real construct+views ${city[0]}`,
				'POST',
				label(`/api/_bench/real/buildings.construct?${city[1]}`, `real construct+views ${city[0]}`),
				payload,
			]);
	}
	return out;
}

/** The label of a request's URL (`_bench=`), or null for one not sent by the bench. */
export const labelOf = (url) => {
	try {
		return new URL(url, 'http://x').searchParams.get('_bench');
	} catch {
		return null;
	}
};

export const median = (a) => {
	if (!a.length) return NaN;
	const s = [...a].sort((x, y) => x - y);
	return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
export const quantile = (a, q) => {
	if (!a.length) return NaN;
	const s = [...a].sort((x, y) => x - y);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
