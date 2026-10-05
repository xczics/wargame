/**
 * Performance budgets (from a Docker run's usage log, changelog 200-202): how many queries a full state takes,
 * and that seeding, background tasks and NPC camps do not read or write more than they need.
 */
import { describe, expect, it } from 'vitest';
import { computeViews, createKernel, definePlugin, engineContext, executeCommand, runReport } from '../../src/kernel';
import { plugins } from '../../src/plugins';
import { wrap } from '../../src/plugins/world-map';
import { db, T0, defaultKernel, player, inner } from '../helpers';

/** A database that records every statement prepared through it. */
function counting() {
	const sql: string[] = [];
	const counted = new Proxy(db, {
		get(target, key) {
			if (key === 'prepare')
				return (q: string) => {
					sql.push(q);
					return target.prepare(q);
				};
			const v = Reflect.get(target, key, target);
			return typeof v === 'function' ? v.bind(target) : v;
		},
	});
	return { db: counted, sql };
}

// A command to remove a settlement, as uprooting does (the counter must follow).
const removal = definePlugin({
	id: 'perf-test',
	version: '0',
	dependsOn: ['settlements'],
	setup(ctx) {
		ctx.commands.add<{ id: string }>({
			type: 'perf-test.remove',
			privileged: true,
			parse: (raw) => raw as { id: string },
			execute: (api, { id }) => ctx.services.get('settlements').remove(api, id),
		});
	},
});
const kernel = createKernel([...plugins, removal]);

describe('performance', () => {
	it("a full state stays within a query budget; the player's own heroes are never looked up one by one", async () => {
		const p = player({ 'buildings.speed': 1e6, 'resources.initial': { food: 1e6, wood: 1e6, stone: 1e6, metal: 1e6, gold: 1e6 } });
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		const at = T0 + 2_000;
		const venue = 'tavern';
		for (const slot of [0, 1]) await p.run(at, 'heroes.recruit', { settlement: c.id, venue, slot }).catch(() => {});
		const { db: counted, sql } = counting();
		await computeViews(defaultKernel, counted, engineContext(defaultKernel, p.id, at));
		expect(sql.filter((q) => q.includes('SELECT player_id FROM heroes_heroes WHERE id'))).toEqual([]);
		// About 90 for a player with a capital (each view's rows loaded once, shared through memo).
		expect(sql.length).toBeLessThan(150);
	});

	it("a page's sync (only what it shows, as the client asks) stays under the free plan's 50 queries per invocation", async () => {
		const p = player({ 'buildings.speed': 1e6, 'resources.initial': { food: 1e6, wood: 1e6, stone: 1e6, metal: 1e6, gold: 1e6 } });
		const c = await p.start();
		await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
		for (const slot of [0, 1]) await p.run(T0 + 2_000, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot }).catch(() => {});
		// The client's rule (web/core/game.ts): bands, slots and explicit needs always; blocks with their page.
		type Placed = { page?: string; id?: string; props?: { view?: unknown; gridView?: unknown } };
		const layout = defaultKernel.meta.get('ui')!() as { pages: Placed[]; blocks: Placed[]; bands: Placed[]; slots: Placed[] };
		const always = new Set(['settlements.mine', 'resources.pool', 'mail.unread']);
		for (const b of [...layout.bands, ...layout.slots]) if (typeof b.props?.view === 'string') always.add(b.props.view);
		for (const page of layout.pages.map((x) => x.id!)) {
			const ids = new Set(always);
			for (const b of [...layout.blocks, ...layout.pages.filter((x) => x.id === page)])
				if (b.page === page || b.page === '*' || b.id === page)
					for (const v of [b.props?.view, b.props?.gridView]) if (typeof v === 'string') ids.add(v);
			const { db: counted, sql } = counting();
			await computeViews(defaultKernel, counted, engineContext(defaultKernel, p.id, T0 + 3_000), [...ids]);
			expect(sql.length, page).toBeLessThan(50);
		}
	});

	it('views after a command start from what it kept current, and come out the same as read afresh', async () => {
		const rich = { food: 1e7, wood: 1e7, stone: 1e7, metal: 1e7, gold: 1e7 };
		const rules = { 'buildings.speed': 1e6, 'resources.initial': rich, 'resources.baseCapacity': 1e8 };
		const p = player(rules);
		const c = await p.start();
		const ctx = (now: number, privileged = false) => engineContext(defaultKernel, p.id, now, p.overrides, privileged);
		let now = T0;
		const step = async (type: string, payload: unknown, privileged = false) => {
			now += 5_000;
			const { carried } = await executeCommand(defaultKernel, db, ctx(now, privileged), type, payload);
			expect(carried.size, type).toBeGreaterThan(0);
			const reused = await computeViews(defaultKernel, db, ctx(now), undefined, { settlement: c.id }, [], carried);
			const afresh = await computeViews(defaultKernel, db, ctx(now), undefined, { settlement: c.id });
			expect(reused.views, type).toEqual(afresh.views);
		};
		const slot = (n: number) => ({ settlement: c.id, district: inner(c).id, slot: n });
		await step('buildings.construct', { ...slot(0), building: 'tavern' });
		await step('buildings.construct', { ...slot(1), building: 'barracks' });
		await step('buildings.construct', { ...slot(2), building: 'institute' });
		await step('buildings.construct', { ...slot(1) }); // an upgrade
		await step('heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		await step('troops.train', { settlement: c.id, unit: 'infantry-1', count: 5 });
		await step('items.grant', { item: 'grain-voucher', count: 2 }, true);
		await step('items.use.grain-voucher', { settlement: c.id });
		await step('research.start', { tech: 'agriculture', settlement: c.id });
		// What it saves: the city page's views after an upgrade, from what the command kept vs read afresh.
		now += 5_000;
		const { carried } = await executeCommand(defaultKernel, db, ctx(now), 'buildings.construct', slot(1));
		const city = ['settlements.detail', 'buildings.slots', 'resources.pool', 'resources.production', 'heroes.cards'];
		const reused = counting();
		await computeViews(defaultKernel, reused.db, ctx(now), city, { settlement: c.id }, [], carried);
		const afresh = counting();
		await computeViews(defaultKernel, afresh.db, ctx(now), city, { settlement: c.id });
		expect(reused.sql.length).toBeLessThan(afresh.sql.length - 4);
	});

	it('seeding 32 blocks (about 100 camps) sends a few dozen statements: inserts merged, nothing read for new settlements', async () => {
		let sent = 0;
		const counted = new Proxy(db, {
			get(target, key) {
				if (key === 'prepare')
					return (q: string) => {
						const st = target.prepare(q);
						return new Proxy(st, {
							get(t, k) {
								if (k === 'bind') return (...v: unknown[]) => counting(t.bind(...v));
								if (k === 'all' || k === 'first' || k === 'run') sent++;
								const v = Reflect.get(t, k, t);
								return typeof v === 'function' ? v.bind(t) : v;
							},
						});
					};
				if (key === 'batch')
					return (list: D1PreparedStatement[]) => {
						sent += list.length;
						return target.batch(list);
					};
				const v = Reflect.get(target, key, target);
				return typeof v === 'function' ? v.bind(target) : v;
			},
		});
		const counting = (st: D1PreparedStatement): D1PreparedStatement =>
			new Proxy(st, {
				get(t, k) {
					if (k === 'all' || k === 'first' || k === 'run') sent++;
					const v = Reflect.get(t, k, t);
					return typeof v === 'function' ? v.bind(t) : v;
				},
			});
		const camps = async () => (await db.prepare('SELECT COUNT(*) AS n FROM npc_camps_levels').first<{ n: number }>())!.n;
		const before = await camps();
		const blocks = Array.from({ length: 32 }, (_, i) => [i, 50]);
		await executeCommand(kernel, counted, engineContext(kernel, 'npc:world', T0, {}, true), 'npc-camps.populate', { blocks });
		expect((await camps()) - before).toBeGreaterThan(60);
		// Was about 1,600 (10 reads and 6 inserts a camp).
		expect(sent).toBeLessThan(90);
	});

	it('the background seeding fills the world a few blocks a minute, and starts again when the GM raises the density', async () => {
		const run = (rules: Record<string, unknown>, type: string, payload: unknown = null) =>
			executeCommand(kernel, db, engineContext(kernel, 'npc:world', T0, rules, true), type, payload);
		const seeding = async (rules: Record<string, unknown>) =>
			(await runReport(kernel, db, engineContext(kernel, 'npc:world', T0, rules, true), 'npc-camps.seeding', {}))[0] as {
				camps: number;
				target: number;
			};
		const done = async () => (await db.prepare("SELECT value FROM npc_camps_seeding WHERE key = 'done'").first<{ value: string }>())?.value;
		// Four blocks of 512 x 512, two a step.
		const small = { 'npc-camps.density': { blockSize: 512, perBlock: 1, spread: 0 }, 'npc-camps.seedBlocks': 2 };
		await run(small, 'npc-camps.seedStep');
		expect(await done()).toBeUndefined();
		await run(small, 'npc-camps.seedStep');
		expect(JSON.parse((await done())!)).toMatchObject({ blockSize: 512, perBlock: 1 });
		// The GM asks for more: a new pass fills every block up to the new count.
		const more = { ...small, 'npc-camps.density': { blockSize: 512, perBlock: 60, spread: 0 } };
		expect((await seeding(more)).target).toBe(240);
		await run(more, 'npc-camps.seedStep');
		await run(more, 'npc-camps.seedStep');
		expect(JSON.parse((await done())!)).toMatchObject({ perBlock: 60 });
		expect((await seeding(more)).camps).toBeGreaterThanOrEqual(240);
	});

	it('an uprooted camp is replaced elsewhere by the background task', async () => {
		const camps = async () => (await db.prepare('SELECT COUNT(*) AS n FROM npc_camps_levels').first<{ n: number }>())!.n;
		const ctx = engineContext(kernel, 'npc:world', T0, {}, true);
		// One of the world's (a capital's starter camps are not replaced).
		const camp = await db
			.prepare(
				"SELECT s.id FROM settlements_settlements s JOIN npc_camps_levels l ON l.settlement_id = s.id WHERE s.kind = 'npc-fortress' AND l.starter = 0 LIMIT 1",
			)
			.first<{ id: string }>();
		const before = await camps();
		await executeCommand(kernel, db, ctx, 'perf-test.remove', { id: camp!.id });
		expect(await camps()).toBe(before - 1);
		expect((await db.prepare('SELECT kind FROM npc_camps_respawn').all<{ kind: string }>()).results).toEqual([{ kind: 'npc-fortress' }]);
		await executeCommand(kernel, db, ctx, 'npc-camps.respawn', null);
		expect(await camps()).toBe(before);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM npc_camps_respawn').first<{ n: number }>())!.n).toBe(0);
	});

	it("a capital's starter camp taken off the map is not replaced elsewhere", async () => {
		const p = player({}, kernel);
		const c = await p.start();
		const starter = await db
			.prepare(
				`SELECT s.id FROM settlements_settlements s JOIN npc_camps_levels l ON l.settlement_id = s.id
				 WHERE l.starter = 1 AND ((s.x - ? + 1536) % 1024) - 512 BETWEEN -1 AND 1 AND ((s.y - ? + 1536) % 1024) - 512 BETWEEN -1 AND 1`,
			)
			.bind(c.x, c.y)
			.first<{ id: string }>();
		const queued = async () => (await db.prepare('SELECT COUNT(*) AS n FROM npc_camps_respawn').first<{ n: number }>())!.n;
		const before = await queued();
		await executeCommand(kernel, db, engineContext(kernel, 'npc:world', T0, {}, true), 'perf-test.remove', { id: starter!.id });
		expect(await queued()).toBe(before);
	});

	it('a settlement that produces nothing writes no resource rows (its pool reads as the starting amounts)', async () => {
		const p = player();
		const c = await p.start();
		const at = { x: wrap(c.x + 9), y: wrap(c.y + 9) };
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-fortress', ...at }, true);
		const camp = await db
			.prepare('SELECT id FROM settlements_settlements WHERE kind = ? AND x = ? AND y = ?')
			.bind('npc-fortress', at.x, at.y)
			.first<{ id: string }>();
		const rows = await db
			.prepare('SELECT COUNT(*) AS n FROM resources_balances WHERE holder = ?')
			.bind(`settlement:${camp!.id}`)
			.first<{ n: number }>();
		expect(rows?.n).toBe(0);
	});
});
