#!/usr/bin/env node
/**
 * `pnpm sync:counts <data dir> [--top=N] [--page=label,label] [--per-view] [--views=a,b] [--commands] [--unchanged]`: what each page's first-visit sync runs, by call count,
 * to find code that runs over and over on a sync without needing to (user 2026-10-22: "本地测试时可以打一些log, 看看哪些
 * 代码段是同步时反复在执行，但其实明明可以不执行的").
 *
 * Takes the data directory a `pnpm smoke --keep` run printed (stop that server first) and the built `dist/` (`pnpm
 * build`), which it instruments for the run (scripts/lib/instrument.mjs) and puts back after. Each page's state query
 * is sent twice on one server (the first fills what is cached per isolate); the second is counted: per function
 * (calls), per source line (statements run), per module. `--per-view`: each page's views one by one instead (statements
 * each adds to a request with none). Plugin bodies may be listed under the module that assembles
 * them (src/runtime/kernel-instance.ts): the code column tells.
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { boot, ROOT } from './lib/preview.mjs';
import { capturePages } from './lib/bench-plan.mjs';
import { instrumentBundle } from './lib/instrument.mjs';

const args = process.argv.filter((a) => !a.startsWith('--'));
const data = args[2];
if (!data) throw new Error('Usage: pnpm sync:counts <data dir> [--top=N] [--page=label,label]');
const flag = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const TOP = Number(flag('top') ?? 25);
const only = flag('page')?.split(',');
const GM = { username: 'smoke-gm', password: 'smoke-own-password' };
writeFileSync(join(ROOT, 'dist/wargame/.dev.vars'), `GM_USERNAME=${GM.username}\nGM_PASSWORD=smoke-initial-password\nBENCH=1\n`);

const { lines, restore } = instrumentBundle();
const regions = [];
lines.forEach((l, i) => {
	const m = l.match(/^\/\/#region (.*)$/);
	if (m) regions.push([i + 1, m[1]]);
});
const moduleAt = (line) => {
	let ans = '?';
	for (const [at, name] of regions) {
		if (at > line) break;
		ans = name;
	}
	return ans;
};

const { base, stop } = await boot(data);
try {
	const login = await fetch(`${base}/api/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(GM),
	});
	if (!login.ok) throw new Error(`Login failed: ${login.status} ${await login.text()}`);
	const cookie = login.headers.get('set-cookie').split(';')[0];
	const captured = [...(await capturePages(base, cookie))].filter(([label]) => !only || only.includes(label));
	// `--views=a,b`: only these views, under the first page's parameters (what one view runs, line by line).
	const viewsFlag = flag('views');
	const pages = viewsFlag
		? (() => {
				const q = new URLSearchParams(captured[0][1]);
				q.set('views', viewsFlag);
				q.delete('instances');
				return [[viewsFlag, q.toString()]];
			})()
		: captured;
	const get = (q) => fetch(`${base}/api/state?${q}`, { headers: { cookie } }).then((r) => r.text());
	const cov = async (reset) => (await fetch(`${base}/api/__cov${reset ? '?reset=1' : ''}`)).json();

	const statementsOf = (all) => Object.values(Object.values(all)[0].s).reduce((a, n) => a + n, 0);
	/** A query's statements on its second run (the first fills what is cached per isolate). */
	const measure = async (query) => {
		await get(query);
		await cov(true);
		await get(query);
		return statementsOf(await cov(false));
	};
	if (process.argv.includes('--commands')) {
		// A command's request as the client sends it (the page's views, its stamps held, `sync`, `sv`) against the same
		// command alone: what the views after it cost. Dry runs (src/plugins/bench: nothing written), so each repeats.
		const post = async (path, body) =>
			(
				await fetch(`${base}${path}`, {
					method: 'POST',
					headers: { cookie, 'content-type': 'application/json' },
					body: JSON.stringify(body),
				})
			).text();
		const measurePost = async (path, body) => {
			await post(path, body);
			await cov(true);
			await post(path, body);
			return statementsOf(await cov(false));
		};
		const { target } = await (await fetch(`${base}/api/_bench/target`, { headers: { cookie } })).json();
		const specs = [
			['buildings.construct', target, '城池'],
			['mail.read', { all: true }, '城池'],
			['timeline.settle', null, '城池'],
		];
		const rows = [];
		for (const [type, payload, label] of specs) {
			const page = new Map(pages).get(label);
			if (!page || (type === 'buildings.construct' && !target)) continue;
			// What the client holds after the page's sync: its stamps (instances' too), the static views' version. Synced
			// through the bench, whose context the command's matches (the GM looks as a player there: no `g` in the key).
			const state = JSON.parse(await (await fetch(`${base}/api/_bench/sync?${page}`, { headers: { cookie } })).text());
			const q = new URLSearchParams(page);
			q.set('stamps', JSON.stringify(state.stamps ?? {}));
			const instances = JSON.parse(q.get('instances') ?? '[]');
			if (instances.length) q.set('instances', JSON.stringify(instances.map((i) => ({ ...i, stamp: state.instanceStamps?.[i.key] }))));
			if (state.player) q.set('sync', state.player);
			const sv = JSON.parse(await get(page)).staticsVersion;
			if (sv) q.set('sv', sv);
			const alone = await measurePost(`/api/_bench/real/${type}`, payload);
			const withViews = await measurePost(`/api/_bench/real/${type}?${q}`, payload);
			rows.push({ command: type, page: label, alone, withViews, views: withViews - alone });
		}
		console.table(rows);
	} else if (process.argv.includes('--per-view')) {
		// Each page's first visit view by view (and instance by instance), less what a request with none costs.
		for (const [label, query] of pages) {
			const q = new URLSearchParams(query);
			const views = (q.get('views') ?? '').split(',').filter(Boolean);
			const instances = JSON.parse(q.get('instances') ?? '[]');
			q.delete('views');
			q.delete('instances');
			const base = await measure(`${q}&views=`);
			const rows = [];
			for (const v of views) rows.push({ view: v, statements: (await measure(`${q}&views=${v}`)) - base });
			for (const i of instances)
				rows.push({
					view: `${i.view} ${JSON.stringify(i.params)}`,
					statements: (await measure(`${q}&views=&instances=${encodeURIComponent(JSON.stringify([i]))}`)) - base,
				});
			rows.sort((a, b) => b.statements - a.statements);
			console.log(`\n=== ${label}: a request with no view ${base} statements; each view on top of it:`);
			console.table(rows);
		}
	} else
		for (const [label, query0] of pages) {
			let query = query0;
			// `--unchanged`: the sync the client sends next, holding this one's stamps (what a page left open costs).
			if (process.argv.includes('--unchanged')) {
				const st = JSON.parse(await get(query0));
				const q = new URLSearchParams(query0);
				q.set('stamps', JSON.stringify(Object.fromEntries(Object.entries(st.stamps ?? {}).map(([v, o]) => [v, `${st.stampKey}~${o}`]))));
				const inst = JSON.parse(q.get('instances') ?? '[]');
				if (inst.length)
					q.set(
						'instances',
						JSON.stringify(
							inst.map((i) => ({ ...i, stamp: st.instanceStamps?.[i.key] ? `${st.stampKey}~${st.instanceStamps[i.key]}` : undefined })),
						),
					);
				if (st.player) q.set('sync', st.player);
				query = q.toString();
				console.log(`${label}: sent again`, Object.keys(JSON.parse(await get(query)).views ?? {}).join(',') || '(nothing)');
			}
			await get(query);
			await cov(true);
			await get(query);
			const all = await cov(false);
			const file = Object.values(all)[0];
			const fns = [];
			for (const [k, n] of Object.entries(file.f)) {
				if (!n) continue;
				const f = file.fnMap[k];
				const line = f.decl.start.line;
				fns.push({
					calls: n,
					fn: f.name.slice(0, 40),
					module: moduleAt(line).replace(/^src\//, ''),
					line,
					code: lines[line - 1].trim().slice(0, 60),
				});
			}
			fns.sort((a, b) => b.calls - a.calls);
			const byLine = new Map();
			let statements = 0;
			for (const [k, n] of Object.entries(file.s)) {
				if (!n) continue;
				statements += n;
				const line = file.statementMap[k].start.line;
				byLine.set(line, (byLine.get(line) ?? 0) + n);
			}
			const hotLines = [...byLine]
				.sort((a, b) => b[1] - a[1])
				.slice(0, TOP)
				.map(([line, n]) => ({
					statements: n,
					module: moduleAt(line).replace(/^src\//, ''),
					line,
					code: lines[line - 1].trim().slice(0, 80),
				}));
			const byModule = new Map();
			for (const [line, n] of byLine) byModule.set(moduleAt(line), (byModule.get(moduleAt(line)) ?? 0) + n);
			console.log(`\n=== ${label}: ${fns.reduce((a, r) => a + r.calls, 0)} calls in ${fns.length} functions, ${statements} statements`);
			console.table(fns.slice(0, TOP));
			console.table(hotLines);
			console.table(
				[...byModule]
					.sort((a, b) => b[1] - a[1])
					.slice(0, 15)
					.map(([module, n]) => ({ module, statements: n })),
			);
		}
} finally {
	await stop();
	restore();
}
