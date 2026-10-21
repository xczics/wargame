import { cloudflare } from '@cloudflare/vite-plugin';
import vue from '@vitejs/plugin-vue';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { defineConfig, type Plugin } from 'vite';
import { csvRowsJson } from './src/kernel/csv.ts';

/**
 * One dev server for everything: the Vue client (with HMR) plus the Worker, Durable
 * Objects and D1 running in workerd via the Cloudflare plugin.
 *
 * Local data (players, accounts, invites, GM rules) is persisted in `.data/local` and
 * survives restarts; only `pnpm data:reset` deletes it. `wrangler d1 ... --persist-to`
 * in package.json points at the same directory.
 */
// WARGAME_DATA_DIR lets throwaway runs (smoke tests) use their own data without touching yours.
export const LOCAL_DATA_DIR = process.env.WARGAME_DATA_DIR ?? '.data/local';

/**
 * Local servers do not run Cron Triggers, so due timeline events (armies arriving, mail...)
 * would only be committed when someone acts. Fire the Worker's scheduled handler every minute,
 * like production (`triggers.crons` in wrangler.jsonc).
 */
function localCron(): Plugin {
	const start = (server: { httpServer: { address(): AddressInfo | string | null; once(e: 'close', f: () => void): unknown } | null }) => {
		let cpuBefore = workerdCpuMs();
		const timer = setInterval(async () => {
			const address = server.httpServer?.address();
			if (!address || typeof address === 'string') return;
			try {
				// The usage log (USAGE_LOG, scripts/dev.mjs): the runtime's CPU time since the last minute.
				const token = process.env.USAGE_TOKEN;
				if (process.env.USAGE_LOG && token) {
					const now = workerdCpuMs();
					await fetch(`http://localhost:${address.port}/api/usage/cpu`, {
						method: 'POST',
						headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
						body: JSON.stringify({ ms: Math.max(0, now - cpuBefore) }),
					});
					cpuBefore = now;
				}
				await fetch(`http://localhost:${address.port}/cdn-cgi/handler/scheduled?cron=*+*+*+*+*`);
			} catch {
				// The server is restarting or shutting down: try again next minute.
			}
		}, 60_000);
		server.httpServer?.once('close', () => clearInterval(timer));
	};
	return { name: 'wargame-local-cron', configureServer: start, configurePreviewServer: start };
}

/**
 * CPU time (ms) used so far by the workerd processes under this server (the Worker's runtime), for the
 * usage log. Linux (Docker): /proc; elsewhere: ps. 0 when it cannot tell.
 */
function workerdCpuMs(): number {
	if (!process.env.USAGE_LOG) return 0;
	try {
		if (process.platform === 'linux') {
			const tick = 100; // USER_HZ on Linux
			const procs = readdirSync('/proc').filter((d) => /^\d+$/.test(d));
			const stat = new Map(
				procs.flatMap((pid) => {
					try {
						const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
						const rest = s.slice(s.lastIndexOf(')') + 2).split(' ');
						return [
							[
								Number(pid),
								{ name: s.slice(s.indexOf('(') + 1, s.lastIndexOf(')')), ppid: Number(rest[1]), cpu: Number(rest[11]) + Number(rest[12]) },
							],
						];
					} catch {
						return [];
					}
				}),
			);
			const mine = (pid: number): boolean => pid === process.pid || (pid > 1 && !!stat.get(pid) && mine(stat.get(pid)!.ppid));
			let ticks = 0;
			for (const [pid, s] of stat) if (s.name.startsWith('workerd') && mine(pid)) ticks += s.cpu;
			return (ticks * 1000) / tick;
		}
		const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,comm='], { encoding: 'utf8' });
		const rows = out
			.trim()
			.split('\n')
			.map((l) => l.trim().split(/\s+/));
		const ppid = new Map(rows.map((r) => [Number(r[0]), Number(r[1])]));
		const mine = (pid: number): boolean => pid === process.pid || (pid > 1 && ppid.has(pid) && mine(ppid.get(pid)!));
		let ms = 0;
		for (const r of rows)
			if (r.slice(3).join(' ').includes('workerd') && mine(Number(r[0]))) {
				// [[dd-]hh:]mm:ss(.cc)
				const [days, clock] = r[2].includes('-') ? r[2].split('-') : ['0', r[2]];
				const parts = clock.split(':').map(Number).reverse();
				ms += ((parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600 + Number(days) * 86400) * 1000;
			}
		return ms;
	} catch {
		return 0;
	}
}

/**
 * CSV tables parsed at build time, for the Worker only (user 2026-10-21: "这些csv能不能在部署时'预编译'成代码？"): a
 * `?raw` import still gives the text (plugins and third-party ones read it as before), and registers its rows as
 * JSON with the kernel (`precompiledCsv`), so `csvRows` in the Worker only JSON.parses. The client imports no CSV.
 */
function csvPrecompile(): Plugin {
	const kernelData = new URL('./src/kernel/data.ts', import.meta.url).pathname;
	return {
		name: 'wargame-csv-precompile',
		enforce: 'pre',
		applyToEnvironment: (environment) => environment.name !== 'client',
		async load(id) {
			const [file, query] = id.split('?');
			if (query !== 'raw' || !file.endsWith('.csv')) return null;
			const text = readFileSync(file, 'utf8');
			this.addWatchFile(file);
			// A table that does not parse fails where it is read (a plugin's setup), as it would without this.
			let rows: string | null = null;
			try {
				rows = csvRowsJson(text);
			} catch {}
			return [
				`import { precompiledCsv } from ${JSON.stringify(kernelData)};`,
				`const text = ${JSON.stringify(text)};`,
				...(rows === null ? [] : [`precompiledCsv(text, ${JSON.stringify(rows)});`]),
				'export default text;',
			].join('\n');
		},
	};
}

/**
 * The usage log's variables for the dev server's Worker only: never in a build (a deploy builds), the preview
 * server gets them from scripts/dev.mjs.
 */
const usageVars =
	process.env.USAGE_LOG && process.env.USAGE_TOKEN ? { USAGE_LOG: process.env.USAGE_LOG, USAGE_TOKEN: process.env.USAGE_TOKEN } : null;

export default defineConfig(({ command, isPreview }) => ({
	plugins: [
		csvPrecompile(),
		vue(),
		cloudflare({
			// The deployment's own config (wrangler.production.jsonc, not committed) for `pnpm run deploy`.
			...(process.env.WARGAME_WRANGLER_CONFIG ? { configPath: process.env.WARGAME_WRANGLER_CONFIG } : {}),
			persistState: { path: LOCAL_DATA_DIR },
			...(usageVars && command === 'serve' && !isPreview ? { config: { vars: usageVars } } : {}),
		}),
		localCron(),
	],
	server: {
		host: '0.0.0.0',
		port: 5173,
		strictPort: true,
	},
	preview: {
		host: '0.0.0.0',
		port: 4173,
		strictPort: true,
	},
}));
