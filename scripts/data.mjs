#!/usr/bin/env node
// Manage persistent local test data (.data/local): accounts, invites, GM rules, player saves.
// Stop `pnpm dev` / `pnpm preview` first — the dev server keeps the SQLite files open.
//
//   pnpm data:reset            delete everything and recreate the empty schema
//   pnpm data:backup [name]    snapshot to .data/backups/<name> (default: timestamp)
//   pnpm data:restore <name>   replace current data with a snapshot
//   pnpm data:list             list snapshots
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const LOCAL = '.data/local'; // keep in sync with vite.config.ts
const BACKUPS = '.data/backups';

const migrate = () =>
	execFileSync('pnpm', ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', LOCAL], { stdio: 'inherit' });

const [command, name] = process.argv.slice(2);

switch (command) {
	case 'reset':
		rmSync(LOCAL, { recursive: true, force: true });
		console.log(`Deleted ${LOCAL}`);
		migrate();
		break;
	case 'backup': {
		if (!existsSync(LOCAL)) throw new Error(`Nothing to back up: ${LOCAL} does not exist`);
		const target = join(BACKUPS, name ?? new Date().toISOString().replace(/[:.]/g, '-'));
		if (existsSync(target)) throw new Error(`${target} already exists`);
		cpSync(LOCAL, target, { recursive: true });
		console.log(`Backed up to ${target}`);
		break;
	}
	case 'restore': {
		const source = join(BACKUPS, name ?? '');
		if (!name || !existsSync(source)) throw new Error(`Usage: pnpm data:restore <name>  (see pnpm data:list)`);
		rmSync(LOCAL, { recursive: true, force: true });
		cpSync(source, LOCAL, { recursive: true });
		console.log(`Restored ${source} -> ${LOCAL}`);
		migrate(); // snapshot may predate newer migrations
		break;
	}
	case 'list':
		console.log(existsSync(BACKUPS) ? readdirSync(BACKUPS).join('\n') || '(no backups)' : '(no backups)');
		break;
	default:
		console.error('Usage: node scripts/data.mjs <reset|backup [name]|restore <name>|list>');
		process.exit(1);
}
