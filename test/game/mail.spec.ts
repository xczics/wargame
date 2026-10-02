/** The mailbox. */
import { describe, expect, it } from 'vitest';
import { createKernel, definePlugin } from '../../src/kernel';
import { plugins } from '../../src/plugins';
import { wrap } from '../../src/plugins/world-map';
import type { ArmyInfo, MailInbox } from '../../src/shared/api';
import { T0, unitsKernel, player, inbox } from '../helpers';

describe('mailbox', () => {
	it('gets the report once the arrival is committed: armies.sync does it at once, without waiting for the sweep', async () => {
		const p = player({ 'armies.speed': 1e6, 'armies.minSeconds': 0 }, unitsKernel);
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'militia', count: 2 }, true);
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
		// Three scouting trips to empty land, one after the other.
		for (let i = 0; i < 3; i++) {
			const t = T0 + i * 10_000;
			await p.run(t, 'armies.send', { from: c.id, x: wrap(c.x + 20 + i), y: c.y, units: { militia: 1 } });
			const army = ((await p.views(t, ['armies.list']))['armies.list'] as ArmyInfo[]).find((a) => a.phase === 'outbound')!;
			await p.run(army.returnsAt, 'timeline.sync', { entity: `army:${army.id}` }, true);
		}
		const box = await inbox(p, T0 + 60_000);
		expect(box).toMatchObject({ unread: 2, more: false });
		expect(box.messages.map((m) => m.title.text)).toEqual(['war-reports.Report from ({x}, {y})', 'war-reports.Report from ({x}, {y})']);
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
