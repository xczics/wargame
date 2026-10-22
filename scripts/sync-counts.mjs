#!/usr/bin/env node
/**
 * `pnpm sync:counts <data dir> [--top=N] [--page=label,label]`: what each page's first-visit sync runs, by call count,
 * to find code that runs over and over on a sync without needing to (user 2026-10-22: "本地测试时可以打一些log, 看看哪些
 * 代码段是同步时反复在执行，但其实明明可以不执行的").
 *
 * Takes the data directory a `pnpm smoke --keep` run printed (stop that server first) and the built `dist/` (`pnpm
 * build`), which it instruments for the run (scripts/lib/instrument.mjs) and puts back after. Each page's state query
 * is sent twice on one server (the first fills what is cached per isolate); the second is counted: per function
 * (calls), per source line (statements run), per module. Plugin bodies may be listed under the module that assembles
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
writeFileSync(join(ROOT, 'dist/wargame/.dev.vars'), `GM_USERNAME=${GM.username}\nGM_PASSWORD=smoke-initial-password\n`);

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
	const pages = [...(await capturePages(base, cookie))].filter(([label]) => !only || only.includes(label));
	const get = (q) => fetch(`${base}/api/state?${q}`, { headers: { cookie } }).then((r) => r.text());
	const cov = async (reset) => (await fetch(`${base}/api/__cov${reset ? '?reset=1' : ''}`)).json();

	for (const [label, query] of pages) {
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
