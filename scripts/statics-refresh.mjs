#!/usr/bin/env node
/**
 * `pnpm statics:refresh`: bake the deployment's static views (building catalog, tech tree, shop...) again on the next
 * request. They are baked once per version and rules version; a deploy that changed a content table but not the version
 * (a data tweak between releases) leaves the old ones (2026-10-19, user: "加个手动刷新命令就好。持续开发阶段你手动帮我弄就好了").
 *
 * Empties the stored manifest (R2 `static/manifest.json`: nothing matches it, everything is baked anew) and moves the
 * rules' version on (`gm_config_version`), so running isolates look again too. Like a GM rule change: every view's stamp
 * and stored derived value is worked out once more.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CONFIG = 'wrangler.production.jsonc';
const wrangler = (...args) => {
	const r = spawnSync('pnpm', ['exec', 'wrangler', ...args, '-c', CONFIG], { encoding: 'utf8' });
	if (r.status !== 0) {
		console.error(`${r.stdout}${r.stderr}`);
		process.exit(1);
	}
};

const dir = mkdtempSync(join(tmpdir(), 'wargame-'));
try {
	const file = join(dir, 'manifest.json');
	writeFileSync(file, '{}');
	wrangler('r2', 'object', 'put', 'wargame-files/static/manifest.json', '--file', file, '--content-type', 'application/json', '--remote');
} finally {
	rmSync(dir, { recursive: true, force: true });
}
wrangler(
	'd1',
	'execute',
	'DB',
	'--remote',
	'--env',
	'production',
	'--command',
	'INSERT INTO gm_config_version (id, version) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET version = version + 1',
);
console.log('Static views will be baked again on the next request.');
