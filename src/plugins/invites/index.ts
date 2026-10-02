/**
 * Invite-only registration. The GM creates codes (optionally multi-use / expiring) and
 * shares the link; `accounts` asks this plugin's registration guard to accept each signup.
 *
 *   POST   /api/invites        GM: create { maxUses?, expiresInHours?, note? }
 *   GET    /api/invites        GM: list
 *   DELETE /api/invites/:code  GM: revoke
 */
import { definePlugin, GameError } from '../../kernel';
import { json, readJson } from '../../lib/http';
import type { Invite } from '../../shared/api';
import i18nCsv from './data/i18n.csv?raw';

// No 0/O/1/I to keep codes easy to read aloud.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(10));
	const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
	return `${chars.slice(0, 5)}-${chars.slice(5)}`;
}

/** Accept what people actually paste: lowercase, spaces, missing dash. */
function normalize(raw: unknown): string | null {
	if (typeof raw !== 'string') return null;
	const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
	return s.length === 10 ? `${s.slice(0, 5)}-${s.slice(5)}` : null;
}

function intIn(raw: unknown, min: number, max: number, name: string): number {
	if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < min || raw > max) {
		throw new GameError('bad_payload', `${name} must be an integer between ${min} and ${max}`);
	}
	return raw;
}

interface Row {
	code: string;
	created_at: number;
	expires_at: number | null;
	max_uses: number;
	uses: number;
	note: string | null;
	revoked_at: number | null;
}

export default definePlugin({
	id: 'invites',
	version: '0.1.0',
	description: 'GM-issued invite codes gate registration',
	dependsOn: ['accounts', 'i18n'],
	setup(ctx) {
		ctx.services.get('i18n').addCsv(i18nCsv);
		const accounts = ctx.services.get('accounts');
		const toInvite = (row: Row, origin: string): Invite => ({
			code: row.code,
			createdAt: row.created_at,
			expiresAt: row.expires_at,
			maxUses: row.max_uses,
			uses: row.uses,
			note: row.note,
			revoked: row.revoked_at !== null,
			link: `${origin}/?invite=${row.code}`,
		});

		accounts.addRegistrationGuard({
			id: 'invites',
			async claim({ env, userId, fields }) {
				const code = normalize(fields.inviteCode);
				const invalid = new GameError('invalid_invite', 'Invite code is invalid, used up, expired or revoked', 403);
				if (!code) throw invalid;
				const now = Date.now();
				// Atomic claim: only succeeds while the code still has uses left.
				const claimed = await env.DB.prepare(
					`UPDATE invites_codes SET uses = uses + 1
					 WHERE code = ? AND revoked_at IS NULL AND uses < max_uses AND (expires_at IS NULL OR expires_at > ?)
					 RETURNING code`,
				)
					.bind(code, now)
					.first();
				if (!claimed) throw invalid;
				await env.DB.prepare('INSERT INTO invites_redemptions (code, user_id, redeemed_at) VALUES (?, ?, ?)').bind(code, userId, now).run();
				return async () => {
					await env.DB.batch([
						env.DB.prepare('DELETE FROM invites_redemptions WHERE code = ? AND user_id = ?').bind(code, userId),
						env.DB.prepare('UPDATE invites_codes SET uses = uses - 1 WHERE code = ?').bind(code),
					]);
				};
			},
		});

		ctx.routes.add({
			method: 'POST',
			path: '/api/invites',
			async handler({ request, env, url }) {
				const gm = await accounts.requireGM(request, env);
				const body = ((await readJson(request)) ?? {}) as Record<string, unknown>;
				const maxUses = body.maxUses === undefined ? 1 : intIn(body.maxUses, 1, 10_000, 'maxUses');
				const hours =
					body.expiresInHours === undefined || body.expiresInHours === null
						? null
						: intIn(body.expiresInHours, 1, 24 * 365, 'expiresInHours');
				const note = typeof body.note === 'string' ? body.note.slice(0, 200) : null;
				const now = Date.now();
				const row: Row = {
					code: newCode(),
					created_at: now,
					expires_at: hours === null ? null : now + hours * 3600_000,
					max_uses: maxUses,
					uses: 0,
					note,
					revoked_at: null,
				};
				await env.DB.prepare(
					'INSERT INTO invites_codes (code, created_by, created_at, expires_at, max_uses, uses, note) VALUES (?, ?, ?, ?, ?, 0, ?)',
				)
					.bind(row.code, gm.id, row.created_at, row.expires_at, row.max_uses, row.note)
					.run();
				return json(toInvite(row, url.origin), { status: 201 });
			},
		});

		ctx.routes.add({
			method: 'GET',
			path: '/api/invites',
			async handler({ request, env, url }) {
				await accounts.requireGM(request, env);
				const { results } = await env.DB.prepare('SELECT * FROM invites_codes ORDER BY created_at DESC LIMIT 200').all<Row>();
				return json(results.map((r) => toInvite(r, url.origin)));
			},
		});

		ctx.routes.add({
			method: 'DELETE',
			path: '/api/invites/:code',
			async handler({ request, env, params }) {
				await accounts.requireGM(request, env);
				const code = normalize(params.code);
				const res = code
					? await env.DB.prepare('UPDATE invites_codes SET revoked_at = ? WHERE code = ? AND revoked_at IS NULL')
							.bind(Date.now(), code)
							.run()
					: null;
				if (!res?.meta.changes) throw new GameError('not_found', 'No such active invite', 404);
				return json({ ok: true });
			},
		});
	},
});
