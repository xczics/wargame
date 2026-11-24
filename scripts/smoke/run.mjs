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
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
const ALLOWED = /\b(GM|NPC|Wargame|JSON|UTC|ID|HP|Lv|min|ms|px|PNG|SVG|WebP|ICO|KB)\b/g;

// Runs that failed or were kept leave their folder behind (screenshots, a throwaway database): gone after a day.
for (const name of readdirSync(tmpdir()))
	if (name.startsWith('wargame-smoke-')) {
		const old = join(tmpdir(), name);
		if (Date.now() - statSync(old).mtimeMs > 24 * 3600_000) rmSync(old, { recursive: true, force: true });
	}
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
	// A static file the page asks for and does not get (an icon...): the API's own 404s are its answers.
	page.on('response', (r) => r.status() === 404 && !new URL(r.url()).pathname.startsWith('/api/') && problems.push(`404: ${r.url()}`));
	const api = async (method, path, body) => {
		const r = await page.request.fetch(base + path, { method, data: body, headers: { 'content-type': 'application/json' } });
		if (!r.ok()) throw new Error(`${method} ${path}: ${r.status()} ${await r.text()}`);
		return r.json();
	};
	// The site's icon (headless browsers do not fetch it themselves): what the page links, and /favicon.ico for anything else.
	const iconHref = () => page.evaluate(() => [...document.querySelectorAll('link[rel~="icon"]')].map((l) => l.href));
	const checkIcons = async (where) => {
		for (const href of [...(await iconHref()), `${base}/favicon.ico`]) {
			const r = await page.request.fetch(href);
			if (!r.ok() || !r.headers()['content-type']?.startsWith('image/')) problems.push(`${where}: icon ${href} is ${r.status()}`);
		}
	};

	// The GM's first login: only the screen to change the initial password.
	await page.goto(base);
	await checkIcons('login screen');
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
	// The capital's buildings as data (view `buildings.state`): its districts, and what stands or is being built where.
	const buildings = async () => (await api('GET', `/api/state?views=buildings.state&settlement=${capital.id}`)).views['buildings.state'];
	const taken = (state, district) =>
		new Set([...state.slots, ...state.construction].filter((x) => x.district === district).map((x) => x.slot));
	const freeSlots = (state, district) => {
		const used = taken(state, district.id);
		return Array.from({ length: district.slots }, (_, slot) => slot).filter((slot) => !used.has(slot));
	};
	const before = await buildings();
	const inner = before.settlement.districts.find((d) => d.type === 'inner');
	const outer = before.settlement.districts.find((d) => d.type === 'outer');
	const free = freeSlots(before, inner);
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
		'palace',
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
	if (outer) {
		await construct(outer.id, 0, 'farm');
		// A trade post (1.7.0): its entry trades what the routes open.
		await construct(outer.id, 1, 'trade-post');
	}
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
	// The Shuangqing Temple (it needs the institute at 20 and the palace at 15) and that hero posted at the institute,
	// so the temple's entry has an application to show.
	try {
		const now = await buildings();
		const where = (b) => now.slots.filter((s) => s.building === b).map((s) => ({ district: s.district, slot: s.slot }))[0];
		await gm('buildings.setLevel', { settlement: capital.id, ...where('institute'), level: 20 });
		await gm('buildings.setLevel', { settlement: capital.id, ...where('palace'), level: 15 });
		await construct(inner.id, freeSlots(now, inner)[0], 'shuangqing-temple');
		await new Promise((r) => setTimeout(r, 1500));
		const [hero] = (await api('GET', '/api/state?views=heroes.list')).views['heroes.list'];
		await api('POST', '/api/command', { type: 'heroes.assign', payload: { hero: hero.id, duty: 'scholar', target: capital.id } });
	} catch (e) {
		problems.push(`setup: temple: ${e.message.slice(0, 160)}`);
	}
	// The first sync after loading asks for the page's views (1.4.1: a form area's own fetch replaced it and the City
	// page stayed empty until another page was opened).
	// The assistant's page shows only while the GM has it on (gameplay.md §15).
	await api('PUT', '/api/gm/config/assistant.enabled', { value: 1 });
	const firstSync = page.waitForRequest((r) => r.url().includes('/api/state?'));
	await page.reload();
	await page.waitForSelector('nav.tabs button');
	if (!new URL((await firstSync).url()).searchParams.get('views')) problems.push('reload: the first sync asks for no views');
	visited.push('reload: first sync');

	const seen = new Set();
	const EMOJI = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u;
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
		// No emoji anywhere on the page, its tooltips or its tab title (user 2026-11-04: "不用系统图标了"; "如果没有，但渲染
		//出来有，就是还有别的地方在偷偷拼接字符串"): icons are drawn from their ids, never put into a text.
		const shown = await page.evaluate(() =>
			[
				document.title,
				document.body.innerText,
				...[...document.querySelectorAll('[title], option')].map((e) => e.getAttribute('title') ?? e.textContent ?? ''),
			].join('\n'),
		);
		for (const line of new Set(shown.split('\n').filter((l) => EMOJI.test(l))))
			if (!seen.has(`emoji:${line}`)) {
				seen.add(`emoji:${line}`);
				problems.push(`${where}: an emoji was rendered: ${line.trim().slice(0, 120)}`);
			}
		// The page and the Worker come from one build: no "the game has been updated" (2026-11-04: the client and the
		// Worker each worked out their own build id, and every page said so).
		if (await page.locator('.outdated').count()) problems.push(`${where}: the page says the game was updated (build ids differ)`);
		await page.screenshot({ path: join(dir, `${where.replace(/[^\w一-鿿-]+/g, '_')}.png`) });
	};
	const tabs = await page.locator('nav.tabs button').allInnerTexts();
	for (const tab of tabs) {
		await page.locator('nav.tabs button', { hasText: tab }).first().click();
		await scan(`page ${tab}`);
		// A tree that scrolls sideways: its lines move with its cards (user 2026-11-04: "科技树横向滚动时，背后的细线居然独立于卡片不动").
		const moved = await page.evaluate(() => {
			const pane = [...document.querySelectorAll('.columns')].find((p) => p.scrollWidth > p.clientWidth && p.querySelector('.lines path'));
			if (!pane) return null;
			const path = pane.querySelector('.lines path');
			const node = pane.querySelector('[data-node]');
			const before = [path.getBoundingClientRect().left, node.getBoundingClientRect().left];
			pane.scrollLeft = 120;
			const after = [path.getBoundingClientRect().left, node.getBoundingClientRect().left];
			pane.scrollLeft = 0;
			return { line: before[0] - after[0], card: before[1] - after[1] };
		});
		if (moved && Math.abs(moved.line - moved.card) > 1)
			problems.push(`page ${tab}: the tree's lines do not scroll with its cards (lines ${moved.line}px, cards ${moved.card}px)`);
	}
	// The assistant's own tabs; on the research one a target picked, so its plan is shown.
	await page.locator('nav.tabs button', { hasText: '小助手' }).first().click();
	for (const tab of await page.locator('main .assistant nav.tabs button').allInnerTexts()) {
		await page
			.locator('main .assistant nav.tabs button', { hasText: tab.split(' · ')[0] })
			.first()
			.click();
		if (tab.startsWith('科技')) {
			const pick = page.locator('main .assistant select').first();
			const value = await pick.locator('option').nth(1).getAttribute('value');
			if (value) await pick.selectOption(value);
			else problems.push('assistant: no tech to pick on the research tab');
		}
		await scan(`assistant ${tab}`);
	}
	// Idle institutes kept busy (2026-11-20, "随机科研"): the switch on, a look now, and the capital's institute is at work.
	{
		await page.locator('nav.tabs button', { hasText: '科技' }).first().click();
		await page.waitForTimeout(800);
		await page.locator('nav.tabs button', { hasText: '小助手' }).first().click();
		await page.locator('main .assistant nav.tabs button', { hasText: '科技' }).first().click();
		await page.waitForTimeout(300);
		const fill = page.locator('main label.switch', { hasText: '研究所空闲时自动科研' }).locator('input');
		if (!(await fill.count())) problems.push('assistant: no switch to keep idle institutes busy');
		else {
			if (!(await fill.isChecked())) await fill.check();
			await page.locator('main button', { hasText: '立即检查' }).first().click();
			await page.waitForTimeout(3000);
			const state = (await api('GET', `/api/state?settlement=${capital.id}&views=research.state`)).views['research.state'];
			if (!state?.jobs?.length) problems.push('assistant: the switch on and a look, but no research started in the idle institute');
			await fill.uncheck();
		}
		visited.push('assistant: idle institutes kept busy');
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
	// Bought, the item is in the inventory held in the browser at once (2026-11-20: "你告诉前端成功了，前端不就能更新了吗？"):
	// the items page (seen a minute ago, not asked again) lists it.
	{
		await page.locator('nav.tabs button', { hasText: '聚宝阁' }).first().click();
		await page.waitForTimeout(800);
		const card = page.locator('main .card', { has: page.locator('button:not([disabled])', { hasText: '购买' }) }).first();
		const title = (
			(await card
				.locator('.title, h3, h4, b')
				.first()
				.innerText()
				.catch(() => '')) || ''
		)
			.split('×')[0]
			.trim();
		await card.locator('button', { hasText: '购买' }).first().click();
		const notice = page.locator('.notice');
		await notice.waitFor({ timeout: 5000 }).catch(() => {});
		if (await notice.count()) await notice.locator('button').click();
		await page.locator('nav.tabs button', { hasText: '道具' }).first().click();
		await page.waitForTimeout(800);
		if (title && !(await page.locator('main', { hasText: title }).count()))
			problems.push(`shop: bought "${title}", the items page does not list it (the held inventory not updated)`);
		if (!title) problems.push('shop: could not read the bought offer title');
	}
	// Recruited by hand, then the assistant's hero tabs (2026-11-24: "招募新英雄后，英雄相关助手卡死"): each opens and
	// answers (the page not stuck: a timer still runs) with no console error.
	{
		// A free candidate (the GM's gift), so cost and the window's candidates do not matter.
		await gm('heroes.gift', { settlement: capital.id, venue: 'tavern' }).catch(() => {});
		await page.locator('nav.tabs button', { hasText: '英雄' }).first().click();
		await page.waitForTimeout(1500);
		const recruit = page.locator('main button:not([disabled])', { hasText: '招募' }).first();
		if (!(await recruit.count())) problems.push('heroes: no candidate to recruit');
		else {
			await recruit.click();
			await page.waitForTimeout(1500);
			await page.locator('nav.tabs button', { hasText: '小助手' }).first().click();
			for (const tab of ['秘境', '加点', '装备', '营寨']) {
				await page
					.locator('main .assistant nav.tabs button', { hasText: tab })
					.first()
					.click({ timeout: 5000 })
					.catch(() => {});
				const alive = await Promise.race([
					page.evaluate(() => new Promise((r) => setTimeout(() => r(true), 50))),
					new Promise((r) => setTimeout(() => r(false), 5000)),
				]);
				if (!alive) problems.push(`assistant: stuck on the ${tab} tab after recruiting`);
				// The buttons answer for the new hero too (2026-11-24: "主要是秘境和装备对应的按钮点不动").
				if (tab === '秘境') {
					const ids = (await api('GET', '/api/state?views=heroes.list')).views['heroes.list'].map((h) => h.id);
					const offered = await page.locator('main .assistant select option').evaluateAll((os) => os.map((o) => o.value));
					const missing = ids.filter((id) => !offered.includes(id));
					if (missing.length) problems.push(`assistant: the realm tab cannot pick ${missing.length} of the heroes (a new recruit)`);
				}
				// A click answers: a new line in the log, the button free again (2026-11-24: "秘境页的'立即检查'没反应和装备页的'现在
				// 整理'点完没反应").
				const answered = async (button, what) => {
					if (!(await button.count())) return problems.push(`assistant: no "${what}" button`);
					const before = await page.evaluate(() => {
						const key = Object.keys(localStorage).find((k) => k.startsWith('assistant:'));
						return key ? (JSON.parse(localStorage.getItem(key)).log ?? []).length : 0;
					});
					await button.click();
					await page.waitForFunction((el) => !el.disabled, await button.elementHandle(), { timeout: 15_000 }).catch(() => {});
					await page.waitForTimeout(800);
					const after = await page.evaluate(() => {
						const key = Object.keys(localStorage).find((k) => k.startsWith('assistant:'));
						return key ? (JSON.parse(localStorage.getItem(key)).log ?? []).length : 0;
					});
					if (!(await button.isEnabled())) problems.push(`assistant: "${what}" stays busy after recruiting`);
					else if (after <= before) problems.push(`assistant: "${what}" did nothing visible after recruiting (no log line)`);
				};
				if (tab === '秘境') await answered(page.locator('main button', { hasText: '立即检查' }).first(), '立即检查');
				if (tab === '装备') await answered(page.locator('main .assistant button', { hasText: '现在整理（全部城池）' }).first(), '现在整理');
				await scan(`assistant ${tab} after recruiting`);
			}
		}
	}
	// The hero's points: a table, a row per attribute.
	await page.locator('nav.tabs button', { hasText: '英雄' }).first().click();
	await page.waitForTimeout(800);
	await page.locator('main button', { hasText: '管理' }).first().click();
	await scan('hero: manage');
	if ((await page.locator('main table.form-table tbody tr').count()) !== 6) problems.push('hero: the points table has not six rows');
	// Bulk smelting: a few stored pieces (chests), the storage list's button opens its form, which counts as one chooses.
	try {
		await gm('items.grant', { item: 'chest-azure-edge-green', count: 3 });
		for (let i = 0; i < 3; i++)
			await api('POST', '/api/command', { type: 'items.use.chest-azure-edge-green', payload: { settlement: capital.id } });
		await page.reload();
		await page.waitForSelector('nav.tabs button');
		await page.locator('nav.tabs button', { hasText: '英雄' }).first().click();
		await page.waitForTimeout(800);
		await page.locator('main button', { hasText: '批量拆解' }).first().click();
		await scan('equipment: bulk smelting');
		const tally = page.locator('main .tally').first();
		if (!/3 件/.test(await tally.innerText()))
			problems.push(`equipment: the bulk smelt form counts "${await tally.innerText()}", not 3 pieces`);
		const slot = page.locator('main form.dynamic-form select').nth(2);
		const options = await slot.locator('option').allInnerTexts();
		if (options.length > 2) {
			await slot.selectOption({ index: 1 });
			await page.waitForTimeout(300);
			if (/3 件/.test(await tally.innerText())) problems.push('equipment: the bulk smelt count does not follow the chosen slot');
		}
	} catch (e) {
		problems.push(`equipment: bulk smelting: ${e.message.slice(0, 200)}`);
	}
	// The paper doll: the hero dressed from chests of higher sets, a heroine (the music house's) with accessories; each
	// shown on the heroes page, a piece's card opened by pointing at it.
	try {
		// The rows the server forwards (`equipment.items`); a piece's set by its base, from the meta.
		const state = async () => (await api('GET', `/api/state?views=equipment.items&settlement=${capital.id}`)).views['equipment.items'];
		const setOf = new Map((await api('GET', '/api/meta')).equipment.bases.map((b) => [b.id, b.set?.id]));
		const dress = async (hero, chests) => {
			await gm('heroes.grantExp', { hero, exp: 1e7 });
			for (const chest of chests) {
				await gm('items.grant', { item: chest, count: 1 });
				await api('POST', '/api/command', { type: `items.use.${chest}`, payload: { settlement: capital.id } });
				const s = await state();
				for (const p of s.pieces.filter((x) => !x.hero && setOf.get(x.base) && chest.startsWith(`chest-${setOf.get(x.base)}-`)))
					await api('POST', '/api/command', { type: 'equipment.equip', payload: { piece: p.id, hero } }).catch(() => {});
			}
		};
		const him = (await state()).heroes[0].id;
		await dress(him, [
			'chest-phoenix-plume-purple',
			'chest-dragon-stride-gold',
			'chest-heavens-plan-purple',
			'chest-mountain-warden-blue',
			'chest-phoenix-plume-gold',
			'chest-heavens-plan-gold',
		]);
		await gm('heroes.gift', { settlement: capital.id, venue: 'music-house' });
		const gift = (await api('GET', `/api/state?views=heroes.offers&settlement=${capital.id}`)).views['heroes.offers'].venues.find(
			(v) => v.venue === 'music-house',
		).gifts[0];
		await api('POST', '/api/command', {
			type: 'heroes.recruit',
			payload: { settlement: capital.id, venue: 'music-house', gift: gift.id },
		});
		const her = (await api('GET', '/api/state?views=heroes.list')).views['heroes.list'].find(
			(h) => h.gender === 'f' && h.home === capital.id,
		);
		await dress(her.id, [
			'chest-moon-palace-purple',
			'chest-rainbow-robe-gold',
			'chest-drifting-cloud-blue',
			'chest-plain-heart-green',
			'chest-moon-palace-gold',
			'chest-wanderer-blue',
		]);
		await page.reload();
		await page.waitForSelector('nav.tabs button');
		await page.locator('nav.tabs button', { hasText: '英雄' }).first().click();
		await page.waitForTimeout(800);
		const doll = page.locator('main .doll').first();
		await doll.locator('select').first().selectOption(him);
		await page.waitForTimeout(800);
		await doll.screenshot({ path: join(dir, 'doll-hero.png') });
		await doll.locator('select').first().selectOption(her.id);
		await page.waitForTimeout(800);
		await doll.locator('.stage .frame:not(.empty)').first().hover();
		await page.waitForTimeout(300);
		if (!(await doll.locator('.tip').count())) problems.push('equipment: no card when pointing at a worn piece');
		await doll.screenshot({ path: join(dir, 'doll-heroine.png') });
		await scan('equipment: paper doll');
	} catch (e) {
		problems.push(`equipment: paper doll: ${e.message.slice(0, 200)}`);
	}
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
	// A tile's forms are worked out with every sync while shown: only after "操作" (then they stay open).
	if (await page.locator('main .forms form.dynamic-form').count()) problems.push('map: tile forms shown before "操作" was clicked');
	await page
		.locator('main button', { hasText: /^操作$/ })
		.first()
		.click();
	await page.waitForTimeout(800);
	await page
		.locator('main h2', { hasText: '拔除' })
		.first()
		.scrollIntoViewIfNeeded()
		.catch(() => {});
	await scan('map: NPC camp by the capital');
	if (!(await page.locator('main', { hasText: '拔除' }).count())) problems.push('map: no uproot form on a camp by the capital');
	// The attack form on the camp, half filled, survives a sync too (user 2026-10-05: reset when attacking an outpost).
	{
		const count = page.locator('main .forms form.dynamic-form input[type=number]:visible').first();
		if (await count.count()) {
			await count.fill('7');
			await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
			await page.waitForTimeout(1500);
			if ((await count.inputValue()) !== '7') problems.push('forms: the attack form on a camp was reset by a sync');
			visited.push('forms: attack kept through a sync');
		} else problems.push('map: no number field in the forms of a camp');
	}
	// A resource fortress of one's own: one transport form, both ways, each box saying how much there is.
	{
		const fort = { x: wrap(capital.x - 3), y: wrap(capital.y - 3) };
		await api('PUT', '/api/gm/config/player-settlements.limits', { value: { 'fortress-resource': 1 } });
		await gm('settlements.found', { kind: 'fortress-resource', ...fort, name: '冒烟要塞' }).catch((e) =>
			problems.push(`setup: ${e.message}`),
		);
		await page.fill('form.goto input[aria-label=x]', String(fort.x));
		await page.fill('form.goto input[aria-label=y]', String(fort.y));
		await page.locator('form.goto button[type=submit]').click();
		await page.waitForTimeout(800);
		await page.locator(`.cells button.cell[title$="(${fort.x}, ${fort.y})"]`).click();
		await page.waitForTimeout(800);
		await scan('map: transport to a fortress of ones own');
		const transport = page.locator('main .forms form.dynamic-form', { hasText: '按比例尽可能多运' });
		if (!(await transport.count())) problems.push('map: no transport form (with "fill up") on an own fortress');
		else {
			const holders = await transport.locator('input[type=number]').evaluateAll((xs) => xs.map((x) => x.getAttribute('placeholder') ?? ''));
			if (holders.filter((h) => h.startsWith('最多')).length < 10)
				problems.push(`map: transport boxes lack their "at most": ${holders.join(' | ')}`);
		}
	}
	// An empty slot's "build" list (one list a district, the slot added by the client): it opens, and a pick builds there.
	{
		await page.locator('nav.tabs button').first().click();
		await page.waitForTimeout(800);
		const build = page.locator('main button', { hasText: '建造…' }).first();
		if (!(await build.count())) problems.push('city: no empty slot with a build list');
		else {
			await build.click();
			await page.waitForTimeout(500);
			const choices = page.locator('main .choices li button:not([disabled])');
			if ((await page.locator('main .choices li').count()) < 3) problems.push('city: the build list of an empty slot is (almost) empty');
			else if (await choices.count()) {
				await choices.first().click();
				await page.waitForTimeout(1500);
				if (!(await page.locator('main', { hasText: '建造中' }).count()) && !(await page.locator('main', { hasText: '→' }).count()))
					problems.push('city: picking from the build list started nothing');
			}
			await scan('city: build list');
			const back = page.locator('main button', { hasText: '返回' }).first();
			if (await back.count()) await back.click();
		}
	}
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
	// Trade routes (1.7.0): the team picked on the outer city's trade post (hero cards, 2026-11-20), a team out on the
	// Silk Road, a fight played back, the story of a place, and the trade post's trade.
	// The trade post: in the outer city (the district board's cell that counts its slots, "n / m"), built in slot 1
	// after the farm in slot 0: its card's "打开" is the second.
	const openPost = async () => {
		await page.locator('nav.tabs button').first().click();
		await page.waitForTimeout(800);
		await page
			.locator('main .grid button.cell', { hasText: /\d+\s*\/\s*\d+/ })
			.filter({ hasNotText: '内城' })
			.first()
			.click();
		await page.waitForTimeout(800);
		await page
			.locator('main button', { hasText: /^打开$/ })
			.nth(1)
			.click();
		await page.waitForTimeout(800);
	};
	try {
		const [hero] = (await api('GET', '/api/state?views=heroes.list')).views['heroes.list'].filter((h) => h.home === capital.id);
		await api('POST', '/api/command', { type: 'heroes.assign', payload: { hero: hero.id, duty: 'idle', target: null } }).catch(() => {});
		// Every place is guarded (2026-11-20): a column strong enough for the first chapter, two tiers of one family.
		await gm('troops.grant', { settlement: capital.id, unit: 'infantry-4', count: 1000 });
		await openPost();
		if (!(await page.locator('main', { hasText: '派出开拓队' }).count())) problems.push('trade routes: no team form on the trade post');
		else {
			await page.locator('main .depart .slot .face').first().click();
			await page.waitForTimeout(300);
			if (!(await page.locator('main .depart .picker .who').count())) problems.push('trade routes: no hero to pick on the trade post');
			else {
				await page.locator('main .depart .picker .who').first().click();
				await page.locator('main .depart .slot .arms button').first().click();
				await page.waitForTimeout(300);
				if (!(await page.locator('main .depart .slot input[type=range]').count())) problems.push('trade routes: no tier sliders');
			}
			await scan('trade routes: the team form');
			await page.screenshot({ path: join(dir, 'trade-routes-form.png') });
		}
		await page.locator('main button.link', { hasText: '返回' }).first().click();
		await api('POST', '/api/command', {
			type: 'trade-routes.depart',
			payload: {
				settlement: capital.id,
				route: 'silk',
				hours: 1,
				team: [{ hero: hero.id, units: { 'infantry-4': 400, 'infantry-1': 50 } }],
			},
		});
		// The way in (Yumen Gate), then the willow pavilion (a story place).
		const fight = (node) => api('POST', '/api/command', { type: 'trade-routes.fight', payload: { node, heroes: [hero.id] } });
		await fight('silk-1-1');
		await fight('silk-1-2');
		await page.locator('nav.tabs button', { hasText: '商路' }).first().click();
		await page.waitForTimeout(800);
		await scan('trade routes: the team out');
		await page.locator('main button', { hasText: '回看上一战' }).first().click();
		await page.waitForTimeout(1500);
		await scan('trade routes: a fight played');
		// A short fight may be over already ("重播" then).
		const skip = page.locator('.battle button', { hasText: '跳过' });
		if (await skip.count()) await skip.first().click();
		await page.waitForTimeout(300);
		await scan('trade routes: a fight ended');
		await page.screenshot({ path: join(dir, 'trade-routes-battle.png') });
		await page.locator('.battle button', { hasText: '关闭' }).first().click();
		await page.locator('main svg.map g.node.seen', { hasText: '折柳亭' }).first().click();
		await page.waitForTimeout(300);
		await scan('trade routes: a story');
		await page.screenshot({ path: join(dir, 'trade-routes-story.png') });
		await openPost();
		if (!(await page.locator('main', { hasText: '互市' }).count())) problems.push('trade routes: no trade in the trade post');
		await scan('trade routes: the trade post');
		await page.screenshot({ path: join(dir, 'trade-routes-post.png') });
		await page.locator('main button.link', { hasText: '返回' }).first().click();
		// Back to the inner city for the steps after.
		await page.locator('main .grid button.cell', { hasText: '内城' }).first().click();
		await page.waitForTimeout(500);
	} catch (e) {
		problems.push(`trade routes: ${e.message.slice(0, 200)}`);
		await page.screenshot({ path: join(dir, 'trade-routes-failed.png') });
	} finally {
		// Whatever happened, no fight left covering the page for the steps after.
		const close = page.locator('.battle button', { hasText: '关闭' });
		if (await close.count()) await close.first().click();
	}
	// A form half filled survives a sync (the minute poll, another command): the barracks' training count.
	{
		await page.locator('nav.tabs button').first().click();
		await page.waitForTimeout(500);
		let found = false;
		const entries = await open().count();
		for (let i = 0; i < entries && !found; i++) {
			await open().nth(i).click();
			await page.waitForTimeout(800);
			const count = page.locator('main form.dynamic-form input[type=number]:visible').first();
			if (await count.count()) {
				found = true;
				await count.fill('7');
				// A sync: what the minute poll and any command do.
				await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
				await page.waitForTimeout(1500);
				if ((await count.inputValue()) !== '7') problems.push('forms: a half-filled form was reset by a sync');
			}
			await page.locator('main button.link', { hasText: '返回' }).first().click();
		}
		if (!found) problems.push('forms: no entry with a number field to test');
		visited.push('forms: kept through a sync');
	}
	// The GM's mail to everyone with attachments: in the mailbox (its body fetched when opened), claimed once.
	{
		const { id } = await api('POST', '/api/gm/mail/broadcast', {
			title: '冒烟礼包',
			body: '第一行\n第二行',
			attachments: [
				{ kind: 'coupons', config: { amount: 5 } },
				{ kind: 'resources', config: { gold: 100 } },
			],
		});
		await page.locator('.mail-badge').click();
		await page.waitForTimeout(800);
		await page.locator('main .list button.item', { hasText: '冒烟礼包' }).first().click();
		await page.waitForTimeout(1000);
		await scan('mail: a GM mail with attachments');
		const claim = page.locator('main .attachments button', { hasText: '领取' });
		if (!(await claim.count())) problems.push(`mail: no claim button on ${id}`);
		else {
			await claim.click();
			await page.waitForTimeout(1500);
			if (!(await page.locator('main .attachments', { hasText: '已领取' }).count()))
				problems.push('mail: claiming did not show it claimed');
			await scan('mail: attachments claimed');
		}
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
	if (!(await page.locator('.userbox .menu select.locale').count())) problems.push('phone: no language in the user menu');
	if (await page.locator('.band.bottom select.locale').count()) problems.push('phone: the language is still on the bottom band');
	await page.locator('.userbox .name').click();
	await page.setViewportSize({ width: 1440, height: 1000 });
	await page.waitForTimeout(500);
	// The GM console: its badge is in the user menu (on a computer too).
	if (await page.locator('.band.top .gm-badge').count())
		problems.push('desktop: the GM badge is still on the top band, not in the user menu');
	await page.locator('.userbox .name').click();
	await page.locator('.userbox .menu .gm-badge').click();
	await page.waitForTimeout(800);
	for (const tab of await page.locator('main .tabs button').allInnerTexts()) {
		await page.locator('main .tabs button', { hasText: tab }).first().click();
		await scan(`GM ${tab}`);
	}
	// The mail to everyone takes attachments (the generic reward editor, with the server's kinds).
	{
		await page.locator('main .tabs button', { hasText: '群发' }).first().click();
		await page.waitForTimeout(800);
		const add = page.locator('main .broadcast button', { hasText: '添加附件' });
		if (!(await add.count())) problems.push('GM broadcast: no "add an attachment" button');
		else {
			await add.click();
			await page.waitForTimeout(300);
			if ((await page.locator('main .broadcast .reward select').count()) < 1)
				problems.push('GM broadcast: the attachment has no kind to pick');
			await scan('GM broadcast: an attachment');
		}
	}
	// Personalization: a built-in icon chosen on the GM's tab is the tab's icon once the sync brings it.
	{
		await page.locator('main .tabs button', { hasText: '个性化' }).first().click();
		await page.waitForTimeout(500);
		await page.locator('main .personalization button.choice', { hasText: '王冠' }).first().click();
		await page
			.waitForFunction(() => document.querySelector('link[rel~="icon"]')?.getAttribute('href') === '/icons/crown.svg', null, {
				timeout: 5000,
			})
			.catch(async () => problems.push(`personalization: the icon is still ${await iconHref()}`));
		await checkIcons('personalization');
		await api('DELETE', '/api/gm/config/personalization.icon');
	}
	// Opaque research's groups have an editor of their own: a ring of segments.
	{
		await page.locator('main .tabs button', { hasText: '规则' }).first().click();
		await page.waitForTimeout(800);
		await page.locator('main details:has(code:text-is("opaque-research.groups")) > summary').first().click();
		await page.waitForTimeout(300);
		const ring = page.locator('main .rule:has(code:text-is("opaque-research.groups")) svg path');
		if ((await ring.count()) !== 8) problems.push(`GM rules: opaque-research.groups ring has ${await ring.count()} segments, not 8`);
		await scan('GM rules: opaque research ring');
	}
	// The rules: a long map has a filter box; a building's levels are a table (a level a row, a column per resource).
	{
		await page.locator('main .tabs button', { hasText: '规则' }).first().click();
		await page.waitForTimeout(800);
		await page.locator('main details:has(code:text-is("buildings.rules")) > summary').first().click();
		await page.waitForTimeout(300);
		const rule = page.locator('main .rule:has(code:text-is("buildings.rules"))');
		const filter = rule.locator('select.filter');
		if (!(await filter.count())) problems.push('GM rules: no drop-down on buildings.rules');
		else {
			if (await rule.locator('.object .field').count()) problems.push('GM rules: buildings.rules shows entries before one is picked');
			await filter.selectOption('palace');
			await page.waitForTimeout(300);
			if (!(await rule.locator('.object .field').count())) problems.push('GM rules: picking the palace shows nothing');
			if (!(await rule.locator('table.levels').count())) problems.push('GM rules: the palace levels are not a table');
			await scan('GM rules: filtered building levels');
		}
	}
	// Rows of numbers as tables: NPC camp levels (one per kind), cost shares by family (one).
	for (const [key, tables] of [
		['npc-camps.levels', 2],
		['starter-army.costShares', 1],
		['starter-siege.devices', 1],
		['starter-siege.works', 3],
	]) {
		await page.locator(`main details:has(code:text-is("${key}")) > summary`).first().click();
		await page.waitForTimeout(300);
		const rule = page.locator(`main .rule:has(code:text-is("${key}"))`);
		const n = await rule.locator('table.levels').count();
		if (n < tables) problems.push(`GM rules: ${key} shows ${n} tables, not ${tables}`);
		// (Not scanned for words: the other rules' descriptions of this group still name their fields in English.)
		await rule.screenshot({ path: join(dir, `gm-rules-${key}.png`) }).catch(() => {});
		visited.push(`GM rules: ${key} as tables`);
	}
	// A realm task's reward pool: picked from the drop-down, its drops as a table (weight, value), its minimum worth.
	{
		await page.locator('main details:has(code:text-is("realms.pools")) > summary').first().click();
		await page.waitForTimeout(300);
		const rule = page.locator('main .rule:has(code:text-is("realms.pools"))');
		const pick = rule.locator('select.filter');
		if (!(await pick.count())) problems.push('GM rules: no drop-down on realms.pools');
		else {
			await pick.selectOption({ index: 1 });
			await page.waitForTimeout(300);
			if ((await rule.locator('table.levels tbody tr').count()) < 5) problems.push('GM rules: a realm pool shows no table of drops');
			await rule.screenshot({ path: join(dir, 'gm-rules-realms.pools.png') }).catch(() => {});
			visited.push('GM rules: a realm pool');
		}
	}
	// The coupon shop's offers: one table, a row each (price, daily limit, on sale).
	{
		await page.locator('main details:has(code:text-is("shop.offers")) > summary').first().click();
		await page.waitForTimeout(300);
		const rule = page.locator('main .rule:has(code:text-is("shop.offers"))');
		if ((await rule.locator('table.levels tbody tr').count()) < 5) problems.push('GM rules: shop.offers is not a table of offers');
		if ((await rule.locator('table.levels thead th').count()) !== 4)
			problems.push('GM rules: a shop offer row is not price / limit / on sale');
		await rule.screenshot({ path: join(dir, 'gm-rules-shop.offers.png') }).catch(() => {});
		visited.push('GM rules: shop offers');
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
if (problems.length || KEEP) console.log(`Screenshots: ${dir}`);
if (problems.length) {
	console.error(`\nSmoke test: ${problems.length} problem(s)\n${problems.map((p) => `  - ${p}`).join('\n')}`);
	if (!KEEP) process.exit(1);
} else {
	console.log('\nSmoke test passed: no console errors, no untranslated text, no emoji.');
	// Nothing to look at: the screenshots and the database go (a kept run keeps them until a day old).
	if (!KEEP) rmSync(dir, { recursive: true, force: true });
}
