/** The mailbox. */
import { describe, expect, it } from 'vitest';
import { createKernel, definePlugin } from '../../src/kernel';
import { plugins } from '../../src/plugins';
import { wrap } from '../../src/plugins/world-map';
import type { ArmyInfo, DefenseMail, MailInbox, MarchMail, ShopWallet } from '../../src/shared/api';
import { T0, battleOf, db, defaultKernel, unitsKernel, player, inbox } from '../helpers';

describe('mailbox', () => {
	it('gets the report once the arrival is committed: armies.sync does it at once, without waiting for the sweep', async () => {
		const p = player({ 'armies.speed': 1e6, 'armies.minSeconds': 0 }, unitsKernel);
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'militia', count: 2 }, true);
		// A battle (only battles make reports): a camp to lose against.
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', x: wrap(c.x + 20), y: c.y, level: 1 }, true);
		await p.run(T0, 'armies.send', { from: c.id, x: wrap(c.x + 20), y: c.y, units: { militia: 2 } });
		const at = T0 + 1_500; // there after 1 s, home after 2 s
		// Views show the arrival in passing (their writes are dropped): the report, but no mail yet.
		expect(((await p.views(at, ['armies.list']))['armies.list'] as ArmyInfo[])[0].report).not.toBeNull();
		expect((await inbox(p, at)).messages).toEqual([]);
		await p.run(at, 'armies.sync');
		expect((await inbox(p, at)).messages).toEqual([expect.objectContaining({ kind: 'war-reports.march' })]);
		await p.run(at, 'armies.sync'); // nothing more is due: no duplicate
		expect((await inbox(p, at)).messages).toHaveLength(1);
	});

	it('collects reports; read, delete, and keep only the newest `mail.keep`', async () => {
		const p = player({ 'armies.speed': 1e6, 'armies.minSeconds': 0, 'mail.keep': 2 }, unitsKernel);
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'militia', count: 3 }, true);
		// Three raids on camps, one after the other (only battles make reports).
		for (let i = 0; i < 3; i++) {
			const t = T0 + i * 10_000;
			await p.run(t, 'npc-camps.spawnAt', { kind: 'npc-outpost', x: wrap(c.x + 20 + i), y: c.y, level: 1 }, true);
			await p.run(t, 'armies.send', { from: c.id, x: wrap(c.x + 20 + i), y: c.y, units: { militia: 1 } });
			const army = ((await p.views(t, ['armies.list']))['armies.list'] as ArmyInfo[]).find((a) => a.phase === 'outbound')!;
			await p.run(army.returnsAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		}
		const box = await inbox(p, T0 + 60_000);
		expect(box).toMatchObject({ unread: 2, more: false });
		expect(box.messages.map((m) => m.title.text)).toEqual(['war-reports.Defeat at ({x}, {y})', 'war-reports.Defeat at ({x}, {y})']);
		expect(box.messages[0].title.vars?.x).toBe(wrap(c.x + 22)); // newest first

		await p.run(T0 + 60_000, 'mail.read', { ids: [box.messages[1].id] });
		expect(await inbox(p, T0 + 60_000)).toMatchObject({ unread: 1 });
		await p.run(T0 + 60_000, 'mail.read', { all: true });
		expect(await inbox(p, T0 + 60_000)).toMatchObject({ unread: 0 });
		await p.run(T0 + 60_000, 'mail.delete', { ids: [box.messages[0].id] });
		expect((await inbox(p, T0 + 60_000)).messages.map((m) => m.id)).toEqual([box.messages[1].id]);
		await expect(p.run(T0 + 60_000, 'mail.delete', { ids: [] })).rejects.toMatchObject({
			text: { text: 'kernel.{0} must be a list of {1}-{2} items', vars: { 0: 'ids' } },
		});

		// Other players' messages are out of reach.
		const q = player(undefined, unitsKernel);
		await q.start();
		await q.run(T0 + 60_000, 'mail.delete', { all: true });
		expect((await inbox(p, T0 + 60_000)).messages).toHaveLength(1);
	});
});

describe('mailbox paging', () => {
	it('pages by 30 without skipping messages sent at the same moment', async () => {
		const mailer = definePlugin({
			id: 'test-mailer',
			version: '0',
			dependsOn: ['mail'],
			setup(ctx) {
				ctx.commands.add<number>({
					type: 'test-mailer.send',
					parse: (raw) => Number(raw),
					async execute(api, n) {
						for (let i = 0; i < n; i++)
							ctx.services.get('mail').send(api, api.playerId, { kind: 'test', title: { text: 'test-mailer.#{0}', vars: { 0: i } } });
					},
				});
			},
		});
		const p = player({}, createKernel([...plugins, mailer]));
		await p.run(T0, 'test-mailer.send', 70); // all at T0
		const seen = new Set<string>();
		let params: Record<string, string> = {};
		const sizes: number[] = [];
		for (;;) {
			const box = (await p.views(T0, ['mail.inbox'], params))['mail.inbox'] as MailInbox;
			sizes.push(box.messages.length);
			for (const m of box.messages) seen.add(m.id);
			if (!box.more) break;
			const last = box.messages[box.messages.length - 1];
			params = { mailBefore: String(last.at), mailBeforeId: last.id };
		}
		expect(sizes).toEqual([30, 30, 10]);
		expect(seen.size).toBe(70);
	});
});

/** An account made at `at`: the GM's mail to everyone reaches only the accounts made before it. */
async function account(id: string, at: number) {
	await db
		.prepare('INSERT INTO accounts_users (id, username, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?)')
		.bind(id, `m${id.slice(0, 12)}`, 'x', 'x', at)
		.run();
}
/** What `POST /api/gm/mail/broadcast` writes (that route's own checks are in test/api.spec.ts). */
async function broadcast(at: number, attachments: unknown[] = [], title = 'News') {
	const rewards = defaultKernel.services.get('rewards');
	const id = `b-${crypto.randomUUID()}`;
	await db
		.prepare('INSERT INTO mail_broadcasts (id, at, title, body, attachments) VALUES (?, ?, ?, ?, ?)')
		.bind(id, at, title, 'Hello', JSON.stringify(attachments.map((a) => rewards.check(a))))
		.run();
	return id;
}
const wallet = async (p: ReturnType<typeof player>, now: number) =>
	((await p.views(now, ['shop.wallet']))['shop.wallet'] as ShopWallet).balance;
const itemCount = async (p: ReturnType<typeof player>, item: string) =>
	(await db.prepare('SELECT count FROM items_inventory WHERE player_id = ? AND item = ?').bind(p.id, item).first<number>('count')) ?? 0;

describe("the GM's mail to everyone", () => {
	const gift = [
		{ kind: 'resources', config: { gold: 500 } },
		{ kind: 'item', config: { item: 'land-grant', count: 2 } },
		{ kind: 'coupons', config: { amount: 30 } },
	];

	it('reaches the accounts made before it (one row for all), with its attachments to claim once', async () => {
		const p = player();
		const c = await p.start();
		await account(p.id, T0 - 1000);
		const id = await broadcast(T0, gift);
		// Made after it, or no account at all: not theirs.
		const late = player();
		await account(late.id, T0 + 1);
		expect((await inbox(late, T0 + 10)).messages.find((m) => m.id === id)).toBeUndefined();
		expect((await inbox(player(), T0 + 10)).messages.find((m) => m.id === id)).toBeUndefined();
		expect(await db.prepare('SELECT COUNT(*) AS n FROM mail_broadcast_marks WHERE broadcast_id = ?').bind(id).first('n')).toBe(0);

		const box = await inbox(p, T0 + 10);
		expect(box.unread).toBe(1);
		const m = box.messages.find((x) => x.id === id)!;
		expect(m).toMatchObject({ kind: 'mail.broadcast', title: { vars: { 0: 'News' } }, read: false, gift: 'unclaimed' });
		expect(m.attachments).toHaveLength(3);
		expect(m.attachments![2]).toMatchObject({ text: 'starter-rewards.{0} yuanbao' });

		// Not deleted while there is something to claim (one by one; "all" leaves it).
		await expect(p.run(T0 + 10, 'mail.delete', { ids: [id] })).rejects.toMatchObject({ code: 'unclaimed' });
		await p.run(T0 + 10, 'mail.delete', { all: true });
		expect((await inbox(p, T0 + 10)).messages.map((x) => x.id)).toContain(id);

		const gold = (await p.pool(T0 + 10, c.id)).amounts.gold;
		await p.run(T0 + 10, 'mail.claim', { id });
		expect((await p.pool(T0 + 10, c.id)).amounts.gold).toBeCloseTo(gold + 500);
		expect(await itemCount(p, 'land-grant')).toBe(2);
		expect(await wallet(p, T0 + 10)).toBe(30);
		expect((await inbox(p, T0 + 10)).messages.find((x) => x.id === id)).toMatchObject({ gift: 'claimed', read: true });
		await expect(p.run(T0 + 20, 'mail.claim', { id })).rejects.toMatchObject({ code: 'claimed' });
		expect(await wallet(p, T0 + 20)).toBe(30);

		// Claimed: it can go.
		await p.run(T0 + 20, 'mail.delete', { ids: [id] });
		expect((await inbox(p, T0 + 20)).messages.find((x) => x.id === id)).toBeUndefined();
		await expect(p.run(T0 + 20, 'mail.claim', { id })).rejects.toMatchObject({ code: 'not_found' });
	});

	it('is claimed once when claimed many times at once', async () => {
		const p = player();
		await p.start();
		await account(p.id, T0 - 1000);
		const id = await broadcast(T0, [{ kind: 'coupons', config: { amount: 100 } }]);
		const tries = await Promise.allSettled(Array.from({ length: 5 }, () => p.run(T0 + 10, 'mail.claim', { id })));
		expect(tries.filter((t) => t.status === 'fulfilled')).toHaveLength(1);
		expect(tries.filter((t) => t.status === 'rejected').map((t) => (t as PromiseRejectedResult).reason.code)).toEqual(
			Array(4).fill('claimed'),
		);
		expect(await wallet(p, T0 + 10)).toBe(100);
	});

	it('refuses what is not there to claim; a claim that cannot be given leaves it unclaimed', async () => {
		const p = player();
		await account(p.id, T0 - 1000);
		const plain = await broadcast(T0);
		const resources = await broadcast(T0, [{ kind: 'resources', config: { food: 10 } }]);
		await expect(p.run(T0 + 10, 'mail.claim', { id: plain })).rejects.toMatchObject({ code: 'no_attachments' });
		await expect(p.run(T0 + 10, 'mail.claim', { id: 'b-nothing' })).rejects.toMatchObject({ code: 'not_found' });
		await expect(p.run(T0 + 10, 'mail.claim', { id: 'not an id' })).rejects.toMatchObject({ code: 'bad_payload' });
		// No capital yet: nowhere to put the resources.
		await expect(p.run(T0 + 10, 'mail.claim', { id: resources })).rejects.toMatchObject({ code: 'no_capital' });
		expect((await inbox(p, T0 + 10)).messages.find((x) => x.id === resources)).toMatchObject({ gift: 'unclaimed' });
		// Another player's message is not there for them.
		expect((await p.views(T0 + 10, ['mail.message'], { mail: crypto.randomUUID() }))['mail.message']).toBeNull();
	});

	it('is read and deleted like any other mail, and pages in time order among them', async () => {
		const mailer = definePlugin({
			id: 'test-mailer',
			version: '0',
			dependsOn: ['mail'],
			setup(ctx) {
				ctx.commands.add<number>({
					type: 'test-mailer.send',
					parse: (raw) => Number(raw),
					async execute(api, n) {
						for (let i = 0; i < n; i++)
							ctx.services
								.get('mail')
								.send(api, api.playerId, { kind: 'test', title: { text: 'test-mailer.#{0}', vars: { 0: i } }, at: api.now + i * 2 });
					},
				});
			},
		});
		const p = player({}, createKernel([...plugins, mailer]));
		await account(p.id, T0 + 1); // after the other tests' mail to everyone (at T0)
		await p.run(T0, 'test-mailer.send', 40); // at T0, T0 + 2, ...
		const gm = [await broadcast(T0 + 1), await broadcast(T0 + 41), await broadcast(T0 + 79)];
		expect((await p.views(T0 + 100, ['mail.unread']))['mail.unread']).toMatchObject({ unread: 43 });
		const seen: { id: string; at: number }[] = [];
		let params: Record<string, string> = {};
		for (;;) {
			const box = (await p.views(T0 + 100, ['mail.inbox'], params))['mail.inbox'] as MailInbox;
			seen.push(...box.messages);
			if (!box.more) break;
			const last = box.messages[box.messages.length - 1];
			params = { mailBefore: String(last.at), mailBeforeId: last.id };
		}
		expect(seen).toHaveLength(43);
		expect(seen.map((m) => m.at)).toEqual([...seen.map((m) => m.at)].sort((a, b) => b - a));
		expect(seen.filter((m) => gm.includes(m.id))).toHaveLength(3);

		await p.run(T0 + 100, 'mail.read', { ids: [gm[0], seen[0].id] });
		expect((await p.views(T0 + 100, ['mail.unread']))['mail.unread']).toMatchObject({ unread: 41 });
		await p.run(T0 + 100, 'mail.read', { all: true });
		expect((await p.views(T0 + 100, ['mail.unread']))['mail.unread']).toMatchObject({ unread: 0 });
		await p.run(T0 + 100, 'mail.delete', { all: true });
		expect(((await p.views(T0 + 100, ['mail.inbox']))['mail.inbox'] as MailInbox).messages).toEqual([]);
	});
});

describe('war reports: one battle, two mails', () => {
	const mailer = definePlugin({
		id: 'test-mailer',
		version: '0',
		dependsOn: ['mail'],
		setup(ctx) {
			ctx.commands.add<number>({
				type: 'test-mailer.send',
				parse: (raw) => Number(raw),
				async execute(api, n) {
					for (let i = 0; i < n; i++)
						ctx.services.get('mail').send(api, api.playerId, { kind: 'test', title: { text: 'test-mailer.#{0}', vars: { 0: i } } });
				},
			});
		},
	});
	const kernel = createKernel([...plugins, mailer]);
	const battleRow = (id: string) => db.prepare('SELECT refs FROM war_reports_battles WHERE id = ?').bind(id).first<{ refs: number }>();

	/** A PvP battle: a's cavalry against b's capital. */
	async function fight(extra: Record<string, unknown> = {}) {
		const fast = { 'armies.speed': 1e6, 'armies.minSeconds': 0, 'pvp.protectionHours': 0, ...extra };
		const a = player(fast, kernel);
		const b = player(fast, kernel);
		const ca = await a.start();
		const cb = await b.start();
		await a.run(T0, 'troops.grant', { settlement: ca.id, unit: 'cavalry-2', count: 200 }, true);
		await b.run(T0, 'troops.grant', { settlement: cb.id, unit: 'infantry-1', count: 5 }, true);
		await a.run(T0, 'armies.send', { from: ca.id, x: cb.x, y: cb.y, units: { 'cavalry-2': 200 } });
		const army = ((await a.views(T0, ['armies.list']))['armies.list'] as ArmyInfo[])[0];
		await a.run(army.arrivesAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		const at = army.arrivesAt;
		const march = (await inbox(a, at)).messages.find((m) => m.kind === 'war-reports.march')!;
		const defense = (await inbox(b, at)).messages.find((m) => m.kind === 'war-reports.defense')!;
		return { a, b, at, march, defense };
	}

	it('stores the battle once; both mails point at it and show the same lanes; it goes with the last of them', async () => {
		const { a, b, at, march, defense } = await fight();
		const id = (march.data as MarchMail).battle!;
		expect(id).toEqual(expect.any(String));
		expect((defense.data as DefenseMail).battle).toBe(id);
		expect(march.data).not.toHaveProperty('report');
		expect(defense.data).not.toHaveProperty('report');
		expect(await battleRow(id)).toEqual({ refs: 2 });
		// The same battle, the same lanes (attacker left, defender right); only the rows' colours are the reader's.
		const cells = (m: typeof march) => m.report!.lanes!.rows.map((r) => r.cells);
		expect(cells(march)).toEqual(cells(defense));
		expect(march.report!.lanes!.rows.map((r) => r.tone)).toEqual(
			defense.report!.lanes!.rows.map((r) => (r.tone === 'good' ? 'bad' : 'good')),
		);

		await a.run(at, 'mail.delete', { ids: [march.id] });
		expect(await battleRow(id)).toEqual({ refs: 1 });
		// The defender's still reads.
		expect((await inbox(b, at)).messages[0].report!.lanes!.rows).toHaveLength(5);
		await b.run(at, 'mail.delete', { all: true });
		expect(await battleRow(id)).toBeNull();
	});

	it('goes when `mail.keep` pushes the mails out', async () => {
		const { a, b, at, march } = await fight({ 'mail.keep': 1 });
		const id = (march.data as MarchMail).battle!;
		await a.run(at + 1, 'test-mailer.send', 1);
		expect((await inbox(a, at)).messages.map((m) => m.kind)).toEqual(['test']);
		expect(await battleRow(id)).toEqual({ refs: 1 });
		await b.run(at + 1, 'test-mailer.send', 3);
		expect((await inbox(b, at)).messages).toHaveLength(1);
		expect(await battleRow(id)).toBeNull();
	});

	it('still shows a mail from before, with the whole report in its own data', async () => {
		const { b, at, defense } = await fight();
		const report = await battleOf(defense.data);
		const old = crypto.randomUUID();
		const { settlement, attackerName } = defense.data as DefenseMail;
		await db
			.prepare('INSERT INTO mail_messages (id, player_id, at, kind, title, vars, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
			.bind(
				old,
				b.id,
				at - 1,
				'war-reports.defense',
				defense.title.text,
				JSON.stringify(defense.title.vars ?? {}),
				JSON.stringify({ settlement, attackerName, report }),
			)
			.run();
		const shown = (await inbox(b, at)).messages.find((m) => m.id === old)!;
		expect(shown.report).toEqual(defense.report);
		// Deleting it touches no battle.
		await b.run(at, 'mail.delete', { ids: [old] });
		expect(await battleRow((defense.data as DefenseMail).battle!)).toEqual({ refs: 2 });
	});
});
