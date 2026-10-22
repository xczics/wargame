#!/usr/bin/env node
/**
 * `pnpm bench:online <base-url> <cookie-file> [rounds]`: the bench routes (src/plugins/bench) against a deployment
 * with `BENCH = "1"`, while `wrangler tail --format json` records each request's `cpuTime` (a Worker cannot time its
 * own CPU); `pnpm bench:tail` then groups the tail by label (docs/workers-performance.md §4).
 *
 *   - `cookie-file`: the session cookie of a player with a capital, `wg_session=<value>` or just the value (from the
 *     browser's dev tools: Application → Cookies). Only that player's rows are read; nothing is written.
 *   - Logs in a browser once with it to record each page's state query (as a first visit sends it), then sends the
 *     plan `rounds` times (default 6), shuffled, a few seconds apart, with a long pause between rounds so that many
 *     requests land on fresh isolates. Each request carries `_n=<number>`; its answer says which isolate served it and
 *     how many requests that isolate had served (`isolate.served`: 1 = the isolate's first request).
 *   - Writes one JSON line per request (`--out=<file>`, default in the system's temp directory): label, number,
 *     status, the client's time, and the isolate. Give it to `pnpm bench:tail` with the tail's output.
 *
 * Options: `--pause=<seconds>` between rounds (default 120), `--gap=<seconds>` most between requests (default 4),
 * `--pages=城池,地图` only those pages, `--only=d1,sync` only labels starting so.
 */
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { benchPlan, capturePages } from './lib/bench-plan.mjs';

const args = process.argv.filter((a) => !a.startsWith('--'));
const opt = (name) =>
	process.argv
		.find((a) => a.startsWith(`--${name}=`))
		?.split('=')
		.slice(1)
		.join('=');
const [base, cookieFile] = [args[2]?.replace(/\/+$/, ''), args[3]];
if (!base || !cookieFile) throw new Error('Usage: pnpm bench:online <base-url> <cookie-file> [rounds] [--out=file] [--pause=s] [--gap=s]');
const ROUNDS = Number(args[4] ?? 6);
const PAUSE = Number(opt('pause') ?? 120) * 1000;
const GAP = Number(opt('gap') ?? 4) * 1000;
const out = opt('out') ?? join(tmpdir(), `bench-online-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const raw = readFileSync(cookieFile, 'utf8').trim();
const cookie = raw.includes('=') ? raw.split(';')[0] : `wg_session=${raw}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const call = async (method, path, body) => {
	const t0 = performance.now();
	const r = await fetch(base + path, {
		method,
		headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
		...(body ? { body: JSON.stringify(body) } : {}),
	});
	const text = await r.text();
	let json = null;
	try {
		json = JSON.parse(text);
	} catch {}
	return { status: r.status, ms: performance.now() - t0, json, text };
};

// 1. Logged in, bench on, a construct target, the pages' queries.
const me = await call('GET', '/api/auth/me');
if (!me.json?.user) throw new Error(`Not logged in with that cookie (${me.status})`);
const probe = await call('GET', '/api/_bench/noop');
if (probe.status === 404) throw new Error('The bench is off on this deployment: set BENCH = "1" in its vars and deploy');
if (probe.status !== 200) throw new Error(`/api/_bench/noop: ${probe.status} ${probe.text.slice(0, 200)}`);
const { target } = (await call('GET', '/api/_bench/target')).json;
let pages = await capturePages(base, cookie);
const onlyPages = opt('pages')?.split(',');
if (onlyPages) pages = new Map([...pages].filter(([p]) => onlyPages.includes(p)));
const onlyLabels = opt('only')?.split(',');
const plan = benchPlan(pages, target).filter(([label]) => !onlyLabels || onlyLabels.some((o) => label.startsWith(o)));
console.log(
	`Player ${me.json.user.username}; pages ${[...pages.keys()].join(', ')}; construct target ${target ? `${target.building} Lv ${target.level}` : 'none'}`,
);
console.log(`${plan.length} requests × ${ROUNDS} rounds, ${PAUSE / 1000} s between rounds. Log: ${out}`);
writeFileSync(out, '');

// 2. The rounds.
let n = 0;
for (let round = 0; round < ROUNDS; round++) {
	const order = [...plan].sort(() => Math.random() - 0.5);
	let fresh = 0;
	for (const [label, method, path, body] of order) {
		n++;
		const r = await call(method, `${path}&_n=${n}`, body);
		const isolate = r.json?.isolate ?? null;
		if (isolate?.served === 1) fresh++;
		const failed = r.status !== 200 || r.json?.ok === false || r.json?.result?.ok === false;
		appendFileSync(
			out,
			JSON.stringify({ n, round, label, status: r.status, clientMs: Math.round(r.ms), isolate, wallMs: r.json?.wallMs, at: Date.now() }) +
				'\n',
		);
		if (failed) console.log(`  ${label}: ${r.status} ${r.text.slice(0, 160)}`);
		await wait(500 + Math.random() * GAP);
	}
	console.log(`round ${round + 1}/${ROUNDS}: ${order.length} requests, ${fresh} on a fresh isolate`);
	if (round < ROUNDS - 1) await wait(PAUSE);
}
console.log(`Done: ${n} requests. Log: ${out}`);
