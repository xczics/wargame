/**
 * The browser's alarm commits a player's due events once (`timeline.settle`, changelog 420): views after it, and every
 * sync later, find them committed instead of working them out in memory again.
 */
import { describe, expect, it } from 'vitest';
import { computeViews, createKernel, definePlugin, engineContext, executeCommand } from '../../src/kernel';
import { plugins } from '../../src/plugins';
import type { SyncData } from '../../src/shared/ui';
import { db, files, inner, player, T0 } from '../helpers';

/** How often the test event's handler ran (in memory or committed), by player. */
const runs = new Map<string, number>();
const ticks = definePlugin({
	id: 'tick-test',
	version: '0',
	dependsOn: ['timeline', 'settlements'],
	setup(ctx) {
		const timeline = ctx.services.get('timeline');
		const settlements = ctx.services.get('settlements');
		timeline.on<{ playerId: string }>('tick-test.tick', async (api, event) => {
			runs.set(event.payload.playerId, (runs.get(event.payload.playerId) ?? 0) + 1);
			api.write(
				api.db
					.prepare('INSERT INTO tick_test (player_id, n) VALUES (?, 1) ON CONFLICT (player_id) DO UPDATE SET n = n + 1')
					.bind(event.payload.playerId),
			);
		});
		ctx.commands.add<{ at: number }>({
			type: 'tick-test.schedule',
			parse: (raw) => raw as { at: number },
			async execute(api, { at }) {
				const capital = await settlements.capital(api, api.playerId);
				timeline.schedule(api, settlements.entity(capital!.id), at, 'tick-test.tick', { playerId: api.playerId });
			},
		});
	},
});
const kernel = createKernel([...plugins, ticks]);

/** The database as D1 sees it: its calls (a batch is one) and whether any wrote. */
function calls() {
	const out = { calls: 0, writes: 0, db: db as D1Database };
	const sqlOf = new WeakMap<object, string>();
	const wrap = (s: D1PreparedStatement, sql: string): D1PreparedStatement => {
		const w = new Proxy(s, {
			get(t, k) {
				if (k === 'bind') return (...v: unknown[]) => wrap(t.bind(...v), sql);
				if (k === 'all' || k === 'first' || k === 'run' || k === 'raw') {
					out.calls++;
					if (!/^\s*SELECT/i.test(sql)) out.writes++;
				}
				const v = Reflect.get(t, k, t);
				return typeof v === 'function' ? v.bind(t) : v;
			},
		});
		sqlOf.set(w, sql);
		return w;
	};
	out.db = new Proxy(db, {
		get(target, key) {
			if (key === 'prepare') return (q: string) => wrap(target.prepare(q), q);
			if (key === 'batch')
				return (list: D1PreparedStatement[]) => {
					out.calls++;
					if (list.some((x) => !/^\s*SELECT/i.test(sqlOf.get(x) ?? ''))) out.writes++;
					return target.batch(list);
				};
			const v = Reflect.get(target, key, target);
			return typeof v === 'function' ? v.bind(target) : v;
		},
	});
	return out;
}

const committed = async (playerId: string) =>
	(await db.prepare('SELECT n FROM tick_test WHERE player_id = ?').bind(playerId).first<number>('n')) ?? 0;

async function setUp() {
	await db.prepare('CREATE TABLE IF NOT EXISTS tick_test (player_id TEXT PRIMARY KEY, n INTEGER NOT NULL)').run();
	const p = player(undefined, kernel);
	const c = await p.start();
	const ctx = (now: number) => ({ ...engineContext(kernel, p.id, now, p.overrides), files, rulesVersion: 1 });
	const settle = (now: number, d: D1Database = db) => executeCommand(kernel, d, ctx(now), 'timeline.settle', null);
	const sync = (now: number, ids = ['resources.pool', 'settlements.mine', 'timeline.due']) =>
		computeViews(kernel, db, ctx(now), ids, { settlement: c.id });
	return { p, c, ctx, settle, sync };
}

describe('timeline.settle', () => {
	it('commits what is due once; the syncs after it work nothing out again', async () => {
		const { p, settle, sync } = await setUp();
		await p.run(T0, 'tick-test.schedule', { at: T0 + 60_000 });
		// Not due yet: the browser is told when to wake.
		expect(((await sync(T0 + 1_000)).views['timeline.due'] as SyncData).items).toEqual([{ at: T0 + 60_000 }]);

		// Due and not committed: a sync works it out in memory (and drops it), and says so (a time in the past).
		const due = await sync(T0 + 61_000);
		expect((due.views['timeline.due'] as SyncData).items).toEqual([{ at: T0 + 60_000 }]);
		expect(runs.get(p.id)).toBe(1);
		await sync(T0 + 62_000);
		expect(runs.get(p.id)).toBe(2); // every sync again, until committed
		expect(await committed(p.id)).toBe(0);

		// The alarm's command: committed once.
		await settle(T0 + 63_000);
		expect(runs.get(p.id)).toBe(3);
		expect(await committed(p.id)).toBe(1);
		const left = await db
			.prepare("SELECT COUNT(*) AS n FROM timeline_events WHERE type = 'tick-test.tick' AND payload LIKE ?")
			.bind(`%${p.id}%`)
			.first<number>('n');
		expect(left).toBe(0);
		// Later syncs: nothing worked out again, nothing more due.
		const after = await sync(T0 + 64_000);
		await sync(T0 + 65_000);
		expect(runs.get(p.id)).toBe(3);
		expect((after.views['timeline.due'] as SyncData).items.every((i) => i.at > T0 + 64_000)).toBe(true);
		await settle(T0 + 66_000);
		expect(await committed(p.id)).toBe(1);
	});

	it('nothing due: one D1 call, nothing written', async () => {
		const { settle } = await setUp();
		const counted = calls();
		await settle(T0 + 1_000, counted.db);
		expect(counted.writes).toBe(0);
		expect(counted.calls).toBe(1);
	});

	it('the player’s buildings finishing: committed by the alarm', async () => {
		const { p, c, settle } = await setUp();
		await p.construct(T0, c.id, inner(c).id, 0, 'barracks');
		const pending = () =>
			db.prepare('SELECT COUNT(*) AS n FROM buildings_construction WHERE settlement_id = ?').bind(c.id).first<number>('n');
		expect(await pending()).toBe(1);
		await settle(T0 + 3_600_000);
		expect(await pending()).toBe(0);
		const level = await db
			.prepare("SELECT level FROM buildings_slots WHERE settlement_id = ? AND building = 'barracks'")
			.bind(c.id)
			.first<number>('level');
		expect(level).toBe(1);
	});

	it('side by side (two tabs, the alarm and a retry): each event committed once', async () => {
		const { p, settle } = await setUp();
		await p.run(T0, 'tick-test.schedule', { at: T0 + 60_000 });
		await p.run(T0, 'tick-test.schedule', { at: T0 + 70_000 });
		await Promise.all([settle(T0 + 80_000), settle(T0 + 80_000), settle(T0 + 80_000)]);
		expect(await committed(p.id)).toBe(2);
	});

	it("touches only the player's own entities", async () => {
		const a = await setUp();
		const b = await setUp();
		await b.p.run(T0, 'tick-test.schedule', { at: T0 + 60_000 });
		await a.settle(T0 + 61_000);
		expect(await committed(b.p.id)).toBe(0);
		await b.settle(T0 + 61_000);
		expect(await committed(b.p.id)).toBe(1);
	});
});
