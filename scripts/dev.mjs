#!/usr/bin/env node
/**
 * `pnpm dev`: apply the local migrations, start the dev server, and on a game with no map yet
 * (empty terrain, e.g. a fresh database) give it one:
 *
 *   - no map in .data/maps/: generate one (`pnpm map:generate`, a new seed);
 *   - maps there: ask which to use, or to generate a new one (without a terminal: the newest).
 *
 * The map is imported once the server answers (`pnpm map:import`, as the GM from .dev.vars).
 * WARGAME_SKIP_MAP=1 skips all of it; WARGAME_DATA_DIR picks another local data directory and
 * WARGAME_MAPS_DIR another maps directory.
 *
 * `--serve`: the same around the production build (`vite preview`, port 4173) instead of the dev
 * server — what the Docker image runs (it writes .dev.vars from GM_USERNAME / GM_PASSWORD first).
 *
 * USAGE_LOG=on (or a number of minutes; "on" = 240): log usage (requests, D1 rows, database size, CPU) every
 * period, kept in the local table `usage_periods` (src/runtime/usage.ts). Never set it for Cloudflare.
 * (Either way the Worker's cron runs every minute: the `localCron` plugin in vite.config.ts.)
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVE = process.argv.includes('--serve');
const DATA = process.env.WARGAME_DATA_DIR ?? '.data/local';
const MAPS = process.env.WARGAME_MAPS_DIR ?? join(ROOT, '.data/maps');
const URL = SERVE ? 'http://localhost:4173' : 'http://localhost:5173';

// CI=true: wrangler applies the migrations without asking (the only question here is the map's).
const run = (cmd, args) => {
	const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CI: 'true' } });
	if (r.status !== 0) process.exit(r.status ?? 1);
};

/** Whether the local game has no terrain yet (asked of the local D1 through wrangler). */
function needsMap() {
	const r = spawnSync(
		'pnpm',
		[
			'exec',
			'wrangler',
			'd1',
			'execute',
			'DB',
			'--local',
			'--persist-to',
			DATA,
			'--json',
			'--command',
			'SELECT COUNT(*) AS n FROM terrain_chunks',
		],
		{ cwd: ROOT, encoding: 'utf8' },
	);
	try {
		return JSON.parse(r.stdout)[0].results[0].n === 0;
	} catch {
		console.warn('Could not check the map of the local game; skipping it.');
		return false;
	}
}

/** Baked maps in .data/maps/, newest first. */
function maps() {
	if (!existsSync(MAPS)) return [];
	return readdirSync(MAPS)
		.map((name) => ({ name, csv: join(MAPS, name, 'map.csv') }))
		.filter((m) => existsSync(m.csv))
		.map((m) => ({ ...m, at: statSync(m.csv).mtimeMs }))
		.sort((a, b) => b.at - a.at);
}

function generate(seed) {
	console.log(`\nGenerating a new map (seed "${seed}")...`);
	run('node', ['scripts/map/generate.mjs', '--seed', seed, '--out', join(MAPS, seed)]);
	return join(MAPS, seed, 'map.csv');
}

/**
 * In a container the GM's credentials come from the environment. `vite preview` reads the copy of
 * .dev.vars that the build put next to the Worker (dist/wargame/), so that is the one written.
 */
function writeDevVars() {
	const { GM_USERNAME: user, GM_PASSWORD: password } = process.env;
	const built = join(ROOT, 'dist/wargame/.dev.vars');
	let vars;
	if (user && password) vars = `GM_USERNAME=${user}\nGM_PASSWORD=${password}\n`;
	else if (existsSync(built))
		vars = readFileSync(built, 'utf8')
			.split('\n')
			.filter((l) => l && !l.startsWith('USAGE_'))
			.map((l) => `${l}\n`)
			.join('');
	else {
		console.error('Set GM_USERNAME and GM_PASSWORD (the game master account).');
		process.exit(1);
	}
	writeFileSync(built, vars, { mode: 0o600 });
	// The usage log is on only for this run, when asked for: as plain variables of the built Worker (.dev.vars
	// only passes the declared secrets). A deploy always builds anew, so they never reach Cloudflare.
	const config = join(ROOT, 'dist/wargame/wrangler.json');
	const worker = JSON.parse(readFileSync(config, 'utf8'));
	const { USAGE_LOG: _log, USAGE_TOKEN: _token, ...rest } = worker.vars ?? {};
	worker.vars = process.env.USAGE_LOG ? { ...rest, USAGE_LOG: process.env.USAGE_LOG, USAGE_TOKEN: process.env.USAGE_TOKEN } : rest;
	writeFileSync(config, JSON.stringify(worker));
}

const newSeed = () => `map-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`;

/** Which map the fresh game gets: generated when there is none, else asked (or the newest). */
async function chooseMap() {
	const list = maps();
	if (!list.length) {
		console.log('\nThe game has no map yet, and there is none in .data/maps/.');
		return generate(newSeed());
	}
	if (!process.stdin.isTTY) {
		console.log(`\nThe game has no map yet: using the newest in .data/maps/ (${list[0].name}).`);
		return list[0].csv;
	}
	console.log('\nThe game has no map yet. Maps in .data/maps/:');
	list.forEach((m, i) => console.log(`  ${i + 1}. ${m.name}  (${new Date(m.at).toLocaleString()})`));
	console.log(`  ${list.length + 1}. Generate a new map`);
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		for (;;) {
			const answer = (await rl.question(`Which one? [1-${list.length + 1}, Enter = 1] `)).trim() || '1';
			const n = Number(answer);
			if (n >= 1 && n <= list.length) return list[n - 1].csv;
			if (n === list.length + 1) {
				const seed = (await rl.question(`Seed for the new map [Enter = random]: `)).trim() || newSeed();
				rl.close();
				return generate(seed);
			}
			console.log('Please answer with one of the numbers.');
		}
	} finally {
		rl.close();
	}
}

/** Import once the dev server answers. */
async function importWhenUp(csv) {
	for (let i = 0; i < 120; i++) {
		try {
			if ((await fetch(`${URL}/api/meta`)).ok) break;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 1000));
	}
	console.log(`\nImporting ${csv} ...`);
	const r = spawn('node', ['scripts/map/import.mjs', csv, '--url', URL, '--yes'], { cwd: ROOT, stdio: 'inherit' });
	r.on('exit', (code) =>
		console.log(code === 0 ? 'Map imported: the game is ready.' : `Map import failed (exit ${code}); try pnpm map:import ${csv}`),
	);
}

// The usage log's token: the local server reports CPU time with it (vite.config.ts), the Worker checks it.
if (process.env.USAGE_LOG) {
	process.env.USAGE_TOKEN = randomUUID();
	console.log(`Usage log on (USAGE_LOG=${process.env.USAGE_LOG}): a line every period, see docs/deployment.md.`);
}
run('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', DATA]);
const csv = process.env.WARGAME_SKIP_MAP ? null : needsMap() ? await chooseMap() : null;
if (SERVE) writeDevVars();
const vite = spawn('pnpm', ['exec', 'vite', ...(SERVE ? ['preview'] : [])], { cwd: ROOT, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => vite.kill(signal));
vite.on('exit', (code) => process.exit(code ?? 0));
if (csv) void importWhenUp(csv);
