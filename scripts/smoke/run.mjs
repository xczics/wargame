#!/usr/bin/env node
/**
 * `pnpm smoke`: the production build in a browser, on a throwaway database (never .data/local).
 *
 *   1. a temporary data directory, its migrations, `pnpm build`, `vite preview` on a free port, with GM
 *      credentials made up for this run (written where `vite preview` reads them: dist/wargame/.dev.vars);
 *   2. Chromium (Playwright): the GM's first login must change the initial password; then a capital, plenty
 *      of resources, some items and troops;
 *   3. every page tab, every building entry of the capital and every tab of the GM console.
 *
 * Fails (exit 1) on console errors, page errors, text still carrying a plugin's prefix ("starter-content.")
 * and English words left in the Chinese UI. `--keep` leaves the server running and prints its address;
 * `--no-build` reuses dist/. Screenshots go to the temporary directory, printed at the end.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const KEEP = process.argv.includes('--keep');
const BUILD = !process.argv.includes('--no-build');
const GM = { username: 'smoke-gm', password: 'smoke-initial-password', changed: 'smoke-own-password' };
// Words that are fine in the Chinese UI: names, units, technical labels.
const ALLOWED = /\b(GM|NPC|Wargame|JSON|UTC|ID|HP|Lv|min|ms|px)\b/g;

const dir = mkdtempSync(join(tmpdir(), 'wargame-smoke-'));
const data = join(dir, 'data');
const run = (cmd, args, env = {}) => {
	const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CI: 'true', ...env } });
	if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})`);
};
const freePort = () =>
	new Promise((resolve) => {
		const s = createServer().listen(0, () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});

console.log(`Smoke test in ${dir}`);
run('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', data]);
if (BUILD || !existsSync(join(ROOT, 'dist/wargame'))) run('pnpm', ['build']);
writeFileSync(join(ROOT, 'dist/wargame/.dev.vars'), `GM_USERNAME=${GM.username}\nGM_PASSWORD=${GM.password}\n`);
const port = await freePort();
const base = `http://localhost:${port}`;
const server = spawn('pnpm', ['exec', 'vite', 'preview', '--port', String(port), '--strictPort'], {
	cwd: ROOT,
	env: { ...process.env, WARGAME_DATA_DIR: data },
	stdio: ['ignore', 'ignore', 'inherit'],
});
const stop = () => server.kill('SIGTERM');

const problems = [];
const visited = [];
let browser;
let page;
try {
	for (let i = 0; ; i++) {
		if (i > 60) throw new Error('The preview server did not answer');
		if (
			await fetch(`${base}/api/meta`).then(
				(r) => r.ok,
				() => false,
			)
		)
			break;
		await new Promise((r) => setTimeout(r, 1000));
	}
	browser = await chromium.launch();
	page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
	page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
	page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
	const api = async (method, path, body) => {
		const r = await page.request.fetch(base + path, { method, data: body, headers: { 'content-type': 'application/json' } });
		if (!r.ok()) throw new Error(`${method} ${path}: ${r.status()} ${await r.text()}`);
		return r.json();
	};

	// The GM's first login: only the screen to change the initial password.
	await page.goto(base);
	await page.fill('input[autocomplete=username]', GM.username);
	await page.fill('input[type=password]', GM.password);
	await page.click('button[type=submit]');
	await page.waitForSelector('text=初始密码');
	await page.waitForLoadState('networkidle');
	await page.fill('input[autocomplete=current-password]', GM.password);
	await page.locator('input[autocomplete=new-password]').nth(0).fill(GM.changed);
	await page.locator('input[autocomplete=new-password]').nth(1).fill(GM.changed);
	await page.click('button[type=submit]');
	await page.waitForSelector('nav.tabs button');

	// A capital with a bit of everything.
	const me = (await api('GET', '/api/auth/me')).user;
	// New accounts usually get theirs at once; found one when not.
	await api('POST', '/api/command', { type: 'settlements.foundCapital', payload: null }).catch(() => {});
	const capital = (await api('GET', '/api/state?views=settlements.mine')).views['settlements.mine'][0];
	const gm = (type, payload) => api('POST', `/api/gm/players/${me.id}/command`, { type, payload });
	for (const r of (await api('GET', '/api/meta')).resources)
		await gm('resources.grant', { resource: r.id, amount: 1e7, settlement: capital.id });
	for (const item of ['city-charter', 'expansion-permit', 'land-grant', 'recruit-edict'])
		await gm('items.grant', { item, count: 2 }).catch((e) => problems.push(`setup: ${e.message}`));
	await gm('troops.grant', { settlement: capital.id, unit: 'infantry-1', count: 100 }).catch((e) => problems.push(`setup: ${e.message}`));
	// Every kind of building in the capital (built at once), so every building entry gets opened.
	await api('PUT', '/api/gm/config/buildings.speed', { value: 1e6 });
	const detail = (await api('GET', `/api/state?views=settlements.detail&settlement=${capital.id}`)).views['settlements.detail'];
	const inner = detail.districts.find((d) => d.type === 'inner');
	const outer = detail.districts.find((d) => d.type === 'outer');
	const free = inner.slots.filter((x) => !x.building).map((x) => x.slot);
	const build = [
		'barracks',
		'archer-camp',
		'cavalry-camp',
		'supply-depot',
		'tavern',
		'academy',
		'music-house',
		'institute',
		'armory',
		'warehouse',
		'hidden-store',
	];
	// Each takes at least a second; a full queue frees up as the earlier ones finish.
	const construct = async (district, slot, building) => {
		for (let attempt = 0; ; attempt++) {
			try {
				return await api('POST', '/api/command', {
					type: 'buildings.construct',
					payload: { settlement: capital.id, district, slot, building },
				});
			} catch (e) {
				if (attempt < 10 && e.message.includes('queue_full')) await new Promise((r) => setTimeout(r, 1000));
				else return problems.push(`setup: ${building}: ${e.message.slice(0, 160)}`);
			}
		}
	};
	for (const [i, building] of build.entries()) await construct(inner.id, free[i], building);
	if (outer) await construct(outer.id, outer.slots[0].slot, 'farm');
	await new Promise((r) => setTimeout(r, 1500));
	// A hero with free points (its "manage" shows the points table) and coupons to buy with (the notice overlay).
	try {
		const venue = (await api('GET', '/api/meta')).heroes.venues.find((v) => v.building === 'tavern').id;
		await api('POST', '/api/command', { type: 'heroes.recruit', payload: { settlement: capital.id, venue, slot: 0 } });
		const [hero] = (await api('GET', '/api/state?views=heroes.list')).views['heroes.list'];
		await gm('heroes.grantExp', { hero: hero.id, exp: 400 });
		await gm('shop.grant', { amount: 10000 });
	} catch (e) {
		problems.push(`setup: hero / coupons: ${e.message.slice(0, 160)}`);
	}
	await page.reload();
	await page.waitForSelector('nav.tabs button');

	const seen = new Set();
	const scan = async (where) => {
		visited.push(where);
		await page.waitForTimeout(800);
		// Technical text (ids, JSON) is shown in <code> / <pre> on purpose; names are the players'.
		const text = (
			await page.evaluate(() => {
				const root = (document.querySelector('main') ?? document.body).cloneNode(true);
				root.querySelectorAll('code, pre').forEach((e) => e.remove());
				document.body.append(root);
				const t = root.innerText;
				root.remove();
				return t;
			})
		).replaceAll(GM.username, '');
		for (const raw of text.split('\n')) {
			const line = raw.trim();
			if (!line || seen.has(line)) continue;
			seen.add(line);
			if (/(^|[\s(（:：])@?[a-z][a-z0-9-]*\.[A-Za-z{@]/.test(line)) problems.push(`${where}: plugin prefix left: ${line.slice(0, 120)}`);
			else if (/[A-Za-z]{4,}/.test(line.replace(ALLOWED, '').replace(/\{[^}]*\}|https?:\S+|`[^`]*`/g, '')))
				problems.push(`${where}: English: ${line.slice(0, 120)}`);
		}
		await page.screenshot({ path: join(dir, `${where.replace(/[^\w一-鿿-]+/g, '_')}.png`) });
	};
	const tabs = await page.locator('nav.tabs button').allInnerTexts();
	for (const tab of tabs) {
		await page.locator('nav.tabs button', { hasText: tab }).first().click();
		await scan(`page ${tab}`);
	}
	// Buying covers the screen with a notice until it is closed.
	await page.locator('nav.tabs button', { hasText: '聚宝阁' }).first().click();
	await page.waitForTimeout(800);
	await page.locator('main button:not([disabled])', { hasText: '购买' }).first().click();
	await page.waitForTimeout(800);
	const notice = page.locator('.notice');
	if (!(await notice.count())) problems.push('shop: no notice after buying');
	else {
		const said = await notice.innerText();
		if (/[A-Za-z]{4,}|[a-z-]+\.[A-Za-z{]/.test(said)) problems.push(`shop: notice not translated: ${said.slice(0, 120)}`);
		await page.screenshot({ path: join(dir, 'shop_notice.png') });
		await notice.locator('button').click();
		await page.waitForTimeout(400);
		if (await notice.count()) problems.push('shop: the notice did not close');
	}
	visited.push('shop: notice');
	// The hero's points: a table, a row per attribute.
	await page.locator('nav.tabs button', { hasText: '英雄' }).first().click();
	await page.waitForTimeout(800);
	await page.locator('main button', { hasText: '管理' }).first().click();
	await scan('hero: manage');
	if ((await page.locator('main table.form-table tbody tr').count()) !== 6) problems.push('hero: the points table has not six rows');
	// An NPC camp next to the capital (where outer cities go): its tile's forms, attack and uproot side by side.
	const wrap = (v) => ((((v + 511) % 1024) + 1024) % 1024) - 511;
	const camp = { x: wrap(capital.x + 2), y: wrap(capital.y + 1) };
	await gm('npc-camps.spawnAt', { kind: 'npc-fortress', ...camp, level: 1 }).catch((e) => problems.push(`setup: ${e.message}`));
	await page.locator('nav.tabs button', { hasText: '地图' }).first().click();
	await page.waitForTimeout(800);
	await page.fill('form.goto input[aria-label=x]', String(camp.x));
	await page.fill('form.goto input[aria-label=y]', String(camp.y));
	await page.locator('form.goto button[type=submit]').click();
	await page.waitForTimeout(800);
	await page.locator(`.cells button.cell[title$="(${camp.x}, ${camp.y})"]`).click();
	await page.waitForTimeout(800);
	await page
		.locator('main h2', { hasText: '拔除' })
		.first()
		.scrollIntoViewIfNeeded()
		.catch(() => {});
	await scan('map: NPC camp by the capital');
	if (!(await page.locator('main', { hasText: '拔除' }).count())) problems.push('map: no uproot form on a camp by the capital');
	// Building entries of the capital (the first page: a building card's "打开" opens its entry).
	const open = () => page.locator('main button', { hasText: /^打开$/ });
	await page.locator('nav.tabs button').first().click();
	await page.waitForTimeout(800);
	const count = await open().count();
	for (let i = 0; i < count; i++) {
		await open().nth(i).click();
		await scan(`entry ${i + 1}`);
		await page.locator('main button.link', { hasText: '返回' }).first().click();
	}
	// A phone: the tabs keep most of the top band; the name opens a menu with the rest.
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(500);
	const tabsWidth = await page.locator('nav.tabs').evaluate((e) => e.getBoundingClientRect().width);
	if (tabsWidth < 390 * 0.4) problems.push(`phone: the tabs get only ${Math.round(tabsWidth)}px of the top band`);
	await page.locator('.userbox .name').click();
	await scan('phone: user menu');
	for (const word of ['GM', '修改密码', '退出'])
		if (!(await page.locator('.userbox .menu', { hasText: word }).count())) problems.push(`phone: no "${word}" in the user menu`);
	await page.locator('.userbox .name').click();
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.waitForTimeout(500);
	// The GM console.
	await page.locator('.gm-badge').click();
	await page.waitForTimeout(800);
	for (const tab of await page.locator('main .tabs button').allInnerTexts()) {
		await page.locator('main .tabs button', { hasText: tab }).first().click();
		await scan(`GM ${tab}`);
	}
} catch (err) {
	problems.push(`smoke run failed: ${err.stack ?? err}`);
	await page?.screenshot({ path: join(dir, 'failure.png') }).catch(() => {});
} finally {
	await browser?.close();
	if (KEEP) console.log(`Server kept at ${base} (data ${data}); stop it with Ctrl-C.`);
	else stop();
}

console.log(`Visited: ${visited.join(', ')}`);
console.log(`Screenshots: ${dir}`);
if (problems.length) {
	console.error(`\nSmoke test: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`);
	if (!KEEP) process.exit(1);
} else {
	console.log('\nSmoke test passed: no console errors, no untranslated text.');
	if (!KEEP) rmSync(data, { recursive: true, force: true });
}
