// Reset a player's password on the live game (docs/deployment.md, 常见问题: 忘了密码): a random temporary password, hashed
// as the game does (src/plugins/accounts/crypto.ts: PBKDF2-SHA256, 100k iterations, 16-byte salt), written with
// must_change = 1 (the player has to pick a new one before playing). Run from the repo root: node scripts/reset-password.mjs <username>
import { execFileSync } from 'node:child_process';
import { webcrypto as c } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const user = process.argv[2];
if (!user || !/^[\w.-]+$/.test(user)) throw new Error('usage: node scripts/reset-password.mjs <username>');
const pw = 'tmp-' + Buffer.from(c.getRandomValues(new Uint8Array(9))).toString('base64url');
const salt = c.getRandomValues(new Uint8Array(16));
const key = await c.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
const bits = await c.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256);
const b64 = (b) => Buffer.from(b).toString('base64');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-'));
const sql = path.join(dir, 'reset.sql');
fs.writeFileSync(
	sql,
	`UPDATE accounts_users SET password_hash = '${b64(bits)}', password_salt = '${b64(salt)}', must_change = 1 WHERE username = '${user}';`,
	{ mode: 0o600 },
);
try {
	const out = execFileSync(
		'pnpm',
		[
			'exec',
			'wrangler',
			'd1',
			'execute',
			'wargame-db',
			'--remote',
			'-c',
			'wrangler.production.jsonc',
			'--env',
			'production',
			'--file',
			sql,
		],
		{ encoding: 'utf8' },
	);
	const changed = /"changes":\s*1\b/.test(out);
	console.log(changed ? `Done. Temporary password for ${user}: ${pw}` : `No account changed (is "${user}" right?)\n${out}`);
} finally {
	fs.rmSync(dir, { recursive: true, force: true });
}
