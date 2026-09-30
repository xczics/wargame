#!/usr/bin/env node
/**
 * Import a baked map (from `pnpm map:generate`, possibly edited) into a running game
 * (docs/design/gameplay.md §4.4). The map replaces ALL terrain; settlements standing on
 * changed tiles are settled first, which is why this goes through the game (the GM command
 * `terrain.importChunks`) instead of writing the database directly.
 *
 *   pnpm map:import <map.csv> [--url http://localhost:5173] [--yes]
 *
 * GM credentials come from GM_USERNAME / GM_PASSWORD, or from .dev.vars for a local server.
 * Locally, run it against `pnpm dev` (or `pnpm preview`): that server uses .data/local.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const W = 1024;
const CHUNK = 32;
const PER_CALL = 8;

function args() {
	const out = { file: '', url: 'http://localhost:5173', yes: false };
	const list = process.argv.slice(2);
	for (let i = 0; i < list.length; i++) {
		if (list[i] === '--url') out.url = list[++i];
		else if (list[i] === '--yes') out.yes = true;
		else if (!out.file && !list[i].startsWith('--')) out.file = list[i];
		else throw new Error(`Unknown argument ${list[i]}`);
	}
	if (!out.file) throw new Error('Usage: pnpm map:import <map.csv> [--url http://localhost:5173] [--yes]');
	return out;
}

function credentials() {
	let { GM_USERNAME: username, GM_PASSWORD: password } = process.env;
	const vars = join(ROOT, '.dev.vars');
	if ((!username || !password) && existsSync(vars)) {
		for (const line of readFileSync(vars, 'utf8').split('\n')) {
			const [k, ...v] = line.split('=');
			if (k.trim() === 'GM_USERNAME') username ||= v.join('=').trim();
			if (k.trim() === 'GM_PASSWORD') password ||= v.join('=').trim();
		}
	}
	if (!username || !password) throw new Error('Set GM_USERNAME and GM_PASSWORD (or put them in .dev.vars)');
	return { username, password };
}

/** Terrain id -> one-character code, from the terrain plugin's data. */
function codes() {
	const lines = readFileSync(join(ROOT, 'src/plugins/terrain/data/terrains.csv'), 'utf8')
		.split(/\r?\n/)
		.filter((l) => l.trim() && !l.trimStart().startsWith('#'));
	const header = lines[0].split(',').map((h) => h.trim());
	return new Map(
		lines.slice(1).map((l) => {
			const row = Object.fromEntries(l.split(',').map((c, i) => [header[i], c.trim()]));
			return [row.id, row.code];
		}),
	);
}

/** Validate the whole file first: a bad cell anywhere rejects the import. */
function readMap(file, code) {
	const rows = readFileSync(file, 'utf8')
		.split(/\r?\n/)
		.filter((l) => l.trim());
	if (rows.length !== W) throw new Error(`Expected ${W} rows, found ${rows.length}`);
	const cells = new Array(W * W);
	rows.forEach((line, y) => {
		const ids = line.split(',');
		if (ids.length !== W) throw new Error(`Row ${y + 1}: expected ${W} cells, found ${ids.length}`);
		ids.forEach((id, x) => {
			const c = code.get(id.trim());
			if (!c) throw new Error(`Row ${y + 1}, column ${x + 1}: unknown terrain "${id}" (known: ${[...code.keys()].join(', ')})`);
			cells[y * W + x] = c;
		});
	});
	return cells;
}

async function main() {
	const opts = args();
	const cells = readMap(opts.file, codes());
	console.log(`${opts.file}: ${W} x ${W}, valid.`);
	if (!opts.yes) {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		const answer = await rl.question(`Replace ALL terrain of the game at ${opts.url}? Type "yes": `);
		rl.close();
		if (answer.trim() !== 'yes') return console.log('Cancelled.');
	}

	const login = await fetch(`${opts.url}/api/auth/login`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(credentials()),
	});
	if (!login.ok) throw new Error(`Login failed: ${login.status} ${await login.text()}`);
	const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
	const { user } = await login.json();
	if (!user?.gm) throw new Error('That account is not the GM');

	// Chunk (cx, cy) covers x = -511 + 32 cx ... and y likewise; its data runs row by row.
	const chunks = [];
	for (let cy = 0; cy < W / CHUNK; cy++)
		for (let cx = 0; cx < W / CHUNK; cx++) {
			let data = '';
			for (let y = 0; y < CHUNK; y++) for (let x = 0; x < CHUNK; x++) data += cells[(cy * CHUNK + y) * W + cx * CHUNK + x];
			chunks.push({ cx, cy, data });
		}
	for (let i = 0; i < chunks.length; i += PER_CALL) {
		const res = await fetch(`${opts.url}/api/gm/players/${user.id}/command`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', cookie },
			body: JSON.stringify({ type: 'terrain.importChunks', payload: { chunks: chunks.slice(i, i + PER_CALL) } }),
		});
		if (!res.ok) throw new Error(`Chunks ${i}-${i + PER_CALL - 1} failed: ${res.status} ${await res.text()}`);
		process.stdout.write(`\r  ${Math.min(i + PER_CALL, chunks.length)} / ${chunks.length} chunks`);
	}
	console.log('\nDone.');
}

main().catch((err) => {
	console.error(err.message ?? err);
	process.exit(1);
});
