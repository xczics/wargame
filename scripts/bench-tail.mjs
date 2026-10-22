#!/usr/bin/env node
/**
 * `pnpm bench:tail <tail-output> [bench-log.jsonl]`: the CPU of each bench label from what
 * `wrangler tail --format json` printed while `pnpm bench:online` ran (docs/workers-performance.md §4).
 *
 * Groups the tail's events by the `_bench` label of their URL (other requests by path: the players' own traffic,
 * for comparison) and prints count, CPU median / p90 and wall-time median. With the bench's own log, each request is
 * matched by its `_n` and split into "fresh" (the first request its isolate served) and "later".
 */
import { readFileSync } from 'node:fs';
import { labelOf, median, quantile } from './lib/bench-plan.mjs';

const [file, logFile] = process.argv.slice(2);
if (!file) throw new Error('Usage: pnpm bench:tail <tail-output> [bench-log.jsonl]');

/** Every top-level JSON object in a text (the tail prints them one after another, pretty-printed or not). */
function objects(text) {
	const out = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (inString) {
			if (c === '\\') i++;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === '{') {
			if (depth++ === 0) start = i;
		} else if (c === '}' && depth > 0 && --depth === 0) {
			try {
				out.push(JSON.parse(text.slice(start, i + 1)));
			} catch {}
		}
	}
	return out;
}

const fresh = new Map();
if (logFile)
	for (const line of readFileSync(logFile, 'utf8').split('\n'))
		if (line.trim()) {
			const r = JSON.parse(line);
			if (r.isolate) fresh.set(String(r.n), r.isolate.served === 1);
		}

const groups = new Map();
let events = 0;
for (const e of objects(readFileSync(file, 'utf8'))) {
	const url = e.event?.request?.url;
	const cpu = e.cpuTime ?? e.event?.cpuTime;
	if (!url || typeof cpu !== 'number') continue;
	events++;
	const u = new URL(url);
	const label = labelOf(url) ?? `(other) ${e.event.request.method ?? ''} ${u.pathname}`;
	if (!groups.has(label)) groups.set(label, { cpu: [], wall: [], fresh: [], later: [], outcomes: new Map() });
	const g = groups.get(label);
	g.cpu.push(cpu);
	if (typeof e.wallTime === 'number') g.wall.push(e.wallTime);
	g.outcomes.set(e.outcome, (g.outcomes.get(e.outcome) ?? 0) + 1);
	const n = u.searchParams.get('_n');
	if (n && fresh.has(n)) (fresh.get(n) ? g.fresh : g.later).push(cpu);
}
const f = (x) => (Number.isNaN(x) ? '' : x.toFixed(1));
console.table(
	[...groups]
		.sort(([a], [b]) => (a.startsWith('(other)') === b.startsWith('(other)') ? a.localeCompare(b) : a.startsWith('(other)') ? 1 : -1))
		.map(([label, g]) => ({
			label,
			n: g.cpu.length,
			'cpu p50': f(median(g.cpu)),
			'cpu p90': f(quantile(g.cpu, 0.9)),
			'wall p50': f(median(g.wall)),
			...(logFile
				? { 'fresh n': g.fresh.length, 'fresh p50': f(median(g.fresh)), 'later n': g.later.length, 'later p50': f(median(g.later)) }
				: {}),
			outcomes: [...g.outcomes].map(([o, c]) => `${o} ${c}`).join(', '),
		})),
);
console.log(`${events} events with a cpuTime; ms.`);
