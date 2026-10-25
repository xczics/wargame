#!/usr/bin/env node
/**
 * `pnpm bench:local <data dir> [isolates] [warm]`: the bench routes (src/plugins/bench) on fresh local isolates, each
 * under the V8 profiler, by phase: every bench request is sent as the first request of a new server (cold), then
 * `warm` more times (default 3) on that server; `isolates` rounds (default 3), medians over them.
 *
 * Takes the data directory a `pnpm smoke --keep` run printed (stop that server first) and the built `dist/` (the
 * smoke run's build, or `pnpm build`). The profile's self time is split by where it ran: V8 itself ("(program)":
 * compiling and parsing, much of a fresh isolate's cost), the garbage collector, the runtime's own JavaScript (the
 * D1 binding's client, request plumbing), the kernel and engine (src/kernel), the rest of our code (plugins, shared,
 * runtime), and the bench route's own code.
 */
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { boot, bundleModules, profiler, ROOT } from './lib/preview.mjs';
import { benchPlan, capturePages, median } from './lib/bench-plan.mjs';

const args = process.argv.filter((a) => !a.startsWith('--'));
const data = args[2];
if (!data) throw new Error('Usage: pnpm bench:local <data dir> [isolates] [warm] [--only=label,label]');
const ISOLATES = Number(args[3] ?? 3);
const WARM = Number(args[4] ?? 3);
const only = process.argv
	.find((a) => a.startsWith('--only='))
	?.slice(7)
	.split(',');
// `--top=label,label`: also the functions with the most self time in those requests (warm ones), by module.
const top = process.argv
	.find((a) => a.startsWith('--top='))
	?.slice(6)
	.split(',');
const GM = { username: 'smoke-gm', password: 'smoke-own-password' };
writeFileSync(join(ROOT, 'dist/wargame/.dev.vars'), `GM_USERNAME=${GM.username}\nGM_PASSWORD=smoke-initial-password\nBENCH=1\n`);

// 1. The session, the pages' queries and a construct target (the smoke run's GM plays a capital).
const first = await boot(data);
const login = await fetch(`${first.base}/api/auth/login`, {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify(GM),
});
if (!login.ok) throw new Error(`Login failed: ${login.status} ${await login.text()}`);
const cookie = login.headers.get('set-cookie').split(';')[0];
const get = async (path) => (await fetch(first.base + path, { headers: { cookie } })).json();
const { target } = await get('/api/_bench/target');
const pages = await capturePages(first.base, cookie);
await first.stop();
const plan = benchPlan(pages, target).filter(([label]) => !only || only.some((o) => label.startsWith(o)));
console.log(`Pages: ${[...pages.keys()].join(', ')}; construct target: ${target ? `${target.building} Lv ${target.level}` : 'none'}`);

// 2. Each request first on a new server, then warm.
const moduleAt = bundleModules();
const CATEGORIES = ['v8', 'gc', 'runtime', 'kernel', 'ours', 'bench'];
const categoryOf = (f) => {
	if (f.functionName === '(program)') return 'v8';
	if (f.functionName === '(garbage collector)') return 'gc';
	if (!f.url.includes('index.js')) return 'runtime';
	const mod = moduleAt(f.lineNumber);
	if (mod.startsWith('src/kernel/')) return 'kernel';
	if (mod.startsWith('src/plugins/bench/')) return 'bench';
	return 'ours';
};
/** Self time by function ("name module"), over the warm requests of the labels asked for (`--top`). */
const byFunction = new Map();
function tally(label, profile) {
	const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
	const counts = byFunction.get(label) ?? new Map();
	byFunction.set(label, counts);
	profile.samples.forEach((s, k) => {
		const f = nodes.get(s).callFrame;
		if (f.functionName === '(idle)') return;
		const where = f.url.includes('index.js') ? moduleAt(f.lineNumber) : f.url.split('/').pop() || f.url;
		const key = `${f.functionName || '(anonymous)'}  ${where}`;
		counts.set(key, (counts.get(key) ?? 0) + (profile.timeDeltas[k] ?? 0) / 1000);
	});
}
/** Self time of a profile (ms): total and by category, idle left out. */
function split(profile) {
	const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
	const out = Object.fromEntries(['total', ...CATEGORIES].map((c) => [c, 0]));
	profile.samples.forEach((s, k) => {
		const f = nodes.get(s).callFrame;
		if (f.functionName === '(idle)') return;
		const ms = (profile.timeDeltas[k] ?? 0) / 1000;
		out.total += ms;
		out[categoryOf(f)] += ms;
	});
	return out;
}
const results = new Map(plan.map(([label]) => [label, { cold: [], warm: [], status: new Set(), note: '' }]));
for (let round = 0; round < ISOLATES; round++) {
	for (const [label, method, path, body] of plan) {
		const { base, stop } = await boot(data);
		const prof = await profiler();
		for (let i = 0; i <= WARM; i++) {
			await prof.start();
			const r = await fetch(base + path, {
				method,
				headers: { cookie, 'content-type': 'application/json' },
				...(body ? { body: JSON.stringify(body) } : {}),
			});
			const answer = await r.text();
			const profile = await prof.stop();
			const cut = split(profile);
			if (i > 0 && top?.some((t) => label.startsWith(t))) tally(label, profile);
			const entry = results.get(label);
			(i === 0 ? entry.cold : entry.warm).push(cut);
			entry.status.add(r.status);
			if (label === 'timers' || label.includes('construct') || label.startsWith('assemble') || label === 'upgrade file') {
				try {
					const j = JSON.parse(answer);
					entry.note =
						label === 'timers'
							? `loop ${j.loop.performance.toFixed(1)} ms (date ${j.loop.date}), after a read ${j.afterRead.performance.toFixed(1)} ms`
							: label.startsWith('assemble')
								? `${j.plugins} plugins, ${j.rules} rules, ${j.overrides} overrides`
								: label === 'upgrade file'
									? `${j.bytes} bytes`
									: JSON.stringify(j.result ?? { ok: j.ok, error: j.error?.code ?? j.error?.message, replaced: j.replaced }).slice(0, 120);
				} catch {}
			}
		}
		prof.close();
		await stop();
	}
}
const med = (list, c) => median(list.map((x) => x[c]));
const rows = [...results].map(([label, { cold, warm, status }]) => ({
	label,
	status: [...status].join('/'),
	cold: med(cold, 'total').toFixed(1),
	warm: med(warm, 'total').toFixed(1),
	...Object.fromEntries(CATEGORIES.map((c) => [`cold ${c}`, med(cold, c).toFixed(1)])),
	...Object.fromEntries(CATEGORIES.map((c) => [`warm ${c}`, med(warm, c).toFixed(1)])),
}));
console.table(
	rows.map(({ label, status, cold, warm, ...rest }) => ({
		label,
		status,
		cold,
		warm,
		...Object.fromEntries(Object.entries(rest).filter(([k]) => k.startsWith('cold '))),
	})),
);
console.table(
	rows.map(({ label, warm, ...rest }) => ({
		label,
		warm,
		...Object.fromEntries(Object.entries(rest).filter(([k]) => k.startsWith('warm '))),
	})),
);
for (const [label, { note }] of results) if (note) console.log(`${label}: ${note}`);
for (const [label, counts] of byFunction) {
	const runs = ISOLATES * WARM;
	console.log(`\n${label}: self time by function, ms per warm request`);
	for (const [k, ms] of [...counts].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${(ms / runs).toFixed(2).padStart(6)}  ${k}`);
}
console.log(`ms of CPU, medians over ${ISOLATES} fresh servers; cold = the server's first request, warm = the ${WARM} after it.`);
