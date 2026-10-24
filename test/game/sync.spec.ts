/**
 * An unchanged sync is answered in one read (changelog 410): the player's record (`readRecord`, read with the session)
 * unchanged and nothing of theirs due, the quiet views held under it are left out without computing a view or a stamp.
 * Whatever changes what the player sees moves the record on: their commits, others' that lock or touch them (an attack,
 * a mail), the GM's mail to everyone, the rules, an event of theirs falling due.
 */
import { describe, expect, it } from 'vitest';
import {
	bumpVersion,
	computeViews,
	createKernel,
	definePlugin,
	engineContext,
	type Kernel,
	packReads,
	playerEntity,
	readRecord,
	type View,
	WORLD,
} from '../../src/kernel';
import { plugins } from '../../src/plugins';
import type { BuildingsState } from '../../src/shared/api';
import { d1Calls, db, files, inner, player, T0 } from '../helpers';

/** Sends another player a mail without locking them (as a report to a player the command did not lock would). */
const mailer = definePlugin({
	id: 'sync-test',
	version: '0',
	dependsOn: ['mail'],
	setup(ctx) {
		ctx.commands.add<{ to: string }>({
			type: 'sync-test.mail',
			parse: (raw) => raw as { to: string },
			execute: async (api, { to }) =>
				ctx.services.get('mail').send(api, to, { kind: 'sync-test.note', title: { text: 'sync-test.Hello' } }),
		});
	},
});
const base = createKernel([...plugins, mailer]);

/** The kernel with every view's compute and stamp noted when they run. */
function watched() {
	const computed: string[] = [];
	const stamped: string[] = [];
	const views = base.views.map((v): View => ({
		...v,
		compute: (api, p) => (computed.push(v.id), v.compute(api, p)),
		...(v.stamp ? { stamp: (api, p) => (stamped.push(v.id), v.stamp!(api, p)) } : {}),
	}));
	return { kernel: { ...base, views } as Kernel, computed, stamped };
}

// The City page as the client asks it (bands' views on every page, the page's own).
const CITY = [
	'settlements.mine',
	'resources.pool',
	'mail.unread',
	'armies.due',
	'armies.incoming',
	'buildings.state',
	'settlements.outline',
	'resources.sources',
];

describe('an unchanged sync', () => {
	const setup = async () => {
		const p = player({ 'pvp.protectionHours': 0, 'armies.speed': 1e6, 'armies.minSeconds': 0 }, base);
		const c = await p.start();
		let held: Record<string, string> = {};
		/** A sync as the HTTP API runs it: the record read with the session (here: a statement standing for it). */
		const sync = async (now: number, rules = 0) => {
			const { kernel, computed, stamped } = watched();
			const { sent, db: counted } = d1Calls();
			const packed = packReads(counted);
			const ctx = { ...engineContext(kernel, p.id, now, p.overrides), files, rulesVersion: rules };
			const session = packed.prepare('SELECT 1 AS session').first();
			const record = readRecord(kernel, packed, p.id, now);
			await session;
			const state = await computeViews(kernel, packed, ctx, CITY, { settlement: c.id }, [], undefined, held, record);
			held = { ...held, ...state.stamps };
			return { state, sent, computed, stamped };
		};
		// The first sync: everything, stamped under the record.
		const first = await sync(T0);
		expect(Object.keys(first.state.views).sort()).toEqual([...CITY].sort());
		expect(Object.values(first.state.stamps ?? {}).every((s) => s.includes('~'))).toBe(true);
		return { p, c, sync };
	};

	it('is answered in one D1 call, no view or stamp worked out; anything else is not', async () => {
		const { p, sync } = await setup();
		const again = await sync(T0 + 1000);
		expect(again.sent).toEqual([3]); // the session, the versions, the timeline's "anything due"
		expect(again.computed).toEqual([]);
		expect(again.stamped).toEqual([]);
		expect(again.state.views).toEqual({});
		expect(Object.keys(again.state.stamps ?? {}).sort()).toEqual([...CITY].sort());
		// Still so later the same day; the next day (what resets daily) works the stamps out again.
		expect((await sync(T0 + 2000)).stamped).toEqual([]);
		// (Without the player's own events in between: the bands come for them during the day.)
		await db.prepare('DELETE FROM timeline_events WHERE player = ?').bind(p.id).run();
		const tomorrow = await sync(T0 + 86_400_000);
		expect(tomorrow.stamped.length).toBeGreaterThan(0);
		expect((await sync(T0 + 86_400_000 + 1000)).stamped).toEqual([]);
	});

	it("the player's commit, an attack, another's mail, the GM's mail to everyone, the rules: each works it out again", async () => {
		const { p, c, sync } = await setup();
		const at = T0 + 1000;
		const quiet = async (t: number, rules = 0) => {
			const r = await sync(t, rules);
			expect(r.computed).toEqual([]);
			return r;
		};
		await quiet(at);

		// The player's own commit: the pool comes again.
		await p.grant(at, 'food', 100, c.id);
		const granted = await sync(at);
		expect(granted.stamped.length).toBeGreaterThan(0);
		expect(Object.keys(granted.state.views)).toContain('resources.pool');
		await quiet(at);

		// Another player's attack (it locks the defender): the incoming attack shows.
		const other = player({ 'pvp.protectionHours': 0, 'armies.speed': 1, 'armies.minSeconds': 0 }, base);
		const oc = await other.start();
		await other.run(at, 'troops.grant', { settlement: oc.id, unit: 'infantry-1', count: 10 }, true);
		await other.run(at, 'armies.send', { from: oc.id, x: c.x, y: c.y, units: { 'infantry-1': 10 } });
		// The march's arrival is the attacker's (its owner found in the commit that made the march).
		const arrival = await db
			.prepare("SELECT player FROM timeline_events WHERE entity IN (SELECT 'army:' || id FROM armies_marches WHERE player_id = ?)")
			.bind(other.id)
			.all<{ player: string }>();
		expect(arrival.results).toEqual([{ player: other.id }]);
		const attacked = await sync(at);
		expect(attacked.state.views['armies.incoming']).toEqual([expect.objectContaining({ settlement: c.id })]);
		await quiet(at);

		// Another player's mail (it touches the player without locking them): the count comes again.
		await other.run(at, 'sync-test.mail', { to: p.id });
		const mailed = await sync(at);
		expect(mailed.state.views['mail.unread']).toEqual({ unread: expect.any(Number), ids: expect.any(Array) });
		await quiet(at);

		// The GM's mail to everyone (written outside any command, with the world's version moved on).
		await bumpVersion(db, WORLD).run();
		expect(Object.keys((await sync(at)).state.views)).toEqual(['mail.unread']);
		await quiet(at);

		// A rule change.
		const ruled = await sync(at, 1);
		expect(ruled.stamped.length).toBeGreaterThan(0);
		await quiet(at, 1);
	});

	it('an event of the player falling due works it out again (nothing committed): the building done shows', async () => {
		const { p, c, sync } = await setup();
		await p.grant(T0, 'wood', 10_000, c.id);
		await p.grant(T0, 'stone', 10_000, c.id);
		await p.construct(T0, c.id, inner(c).id, 0, 'warehouse');
		const state = (await p.views(T0, ['buildings.state'], { settlement: c.id }))['buildings.state'] as BuildingsState;
		const done = state.construction[0].finishesAt;
		// The event is the player's (filled in at commit from the settlement's owner).
		const events = await db
			.prepare('SELECT player FROM timeline_events WHERE entity = ?')
			.bind(`settlement:${c.id}`)
			.all<{ player: string }>();
		expect(events.results.map((e) => e.player)).toContain(p.id);
		await sync(T0); // after the commit
		const before = await sync(done - 1);
		expect(before.computed).toEqual([]);
		const after = await sync(done + 1);
		expect(after.stamped.length).toBeGreaterThan(0);
		const shown = after.state.views['buildings.state'] as BuildingsState;
		expect(shown.construction).toEqual([]);
		expect(shown.slots).toContainEqual(expect.objectContaining({ building: 'warehouse', level: 1 }));
		// The event is still to be committed (by the sweep or the player's next command): until then, nothing is left out.
		expect((await sync(done + 2)).stamped.length).toBeGreaterThan(0);
		await p.run(done + 3, 'timeline.sync', { entity: `settlement:${c.id}` }, true);
		await sync(done + 3);
		expect((await sync(done + 4)).computed).toEqual([]);
	});

	it("a stamp is taken as confirmed only under the player's own record and the same parameters", async () => {
		const { p, c, sync } = await setup();
		const other = player(undefined, base);
		await other.start();
		const held = (await sync(T0 + 1000)).state.stamps!;
		const run = async (record: string, params: Record<string, string>) => {
			const w = watched();
			const ctx = { ...engineContext(w.kernel, p.id, T0 + 1000, p.overrides), files, rulesVersion: 0 };
			await computeViews(w.kernel, db, ctx, CITY, params, [], undefined, held, readRecord(w.kernel, db, record, T0 + 1000));
			return w.stamped.length;
		};
		expect(await run(p.id, { settlement: c.id })).toBe(0);
		// Someone else's record (a client claiming to be another player): not used.
		expect(await run(other.id, { settlement: c.id })).toBeGreaterThan(0);
		// Other parameters (the capital by default, not named): looked at.
		expect(await run(p.id, {})).toBeGreaterThan(0);
		expect(await db.prepare('SELECT version FROM engine_locks WHERE entity = ?').bind(playerEntity(p.id)).first('version')).toBeGreaterThan(
			0,
		);
	});
});
