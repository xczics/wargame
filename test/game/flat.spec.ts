/**
 * Commands' fast path (`Command.flat`, docs/development.md §2.3 "快速通道"): on the same data, the flat form must write
 * exactly what the regular `execute` writes. Both are run against a database that reads for real and records the
 * writes instead of making them (so each sees the same state), then the two lists are compared.
 */
import { describe, expect, it } from 'vitest';
import { computeViews, engineContext, executeCommand, type EngineContext } from '../../src/kernel';
import { wrap } from '../../src/plugins/world-map';
import { db, defaultKernel, inner, player, T0 } from '../helpers';

const READ = /^\s*SELECT\b/i;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** A database that reads for real and keeps the writes it is given (as SQL and values) instead of running them. */
function recorder() {
	const writes: string[] = [];
	const note = (sql: string, values: unknown[]) =>
		writes.push(`${sql.replace(/\s+/g, ' ').trim()} <- ${JSON.stringify(values).replace(UUID, '<id>')}`);
	const wrap = (st: D1PreparedStatement, sql: string, values: unknown[]): D1PreparedStatement =>
		new Proxy(st, {
			get(t, k) {
				if (k === '__rec') return { sql, values };
				if (k === 'bind') return (...v: unknown[]) => wrap(t.bind(...v), sql, v);
				const v = Reflect.get(t, k, t);
				if (typeof v !== 'function') return v;
				if (!READ.test(sql) && (k === 'run' || k === 'all' || k === 'first'))
					return async () => (note(sql, values), { results: [], success: true, meta: {} });
				return v.bind(t);
			},
		});
	const rec = (s: D1PreparedStatement) => (s as unknown as { __rec: { sql: string; values: unknown[] } }).__rec;
	const proxy = new Proxy(db, {
		get(t, k) {
			if (k === 'prepare') return (sql: string) => wrap(t.prepare(sql), sql, []);
			if (k === 'batch')
				return async (list: D1PreparedStatement[]) => {
					const reads = list.filter((s) => READ.test(rec(s).sql));
					for (const s of list) if (!READ.test(rec(s).sql)) note(rec(s).sql, rec(s).values);
					const out = reads.length ? await t.batch(reads) : [];
					let i = 0;
					return list.map((s) => (READ.test(rec(s).sql) ? out[i++] : { results: [], success: true, meta: {} }));
				};
			const v = Reflect.get(t, k, t);
			return typeof v === 'function' ? v.bind(t) : v;
		},
	});
	return { db: proxy as D1Database, writes };
}

/**
 * The writes that are game state (not the engine's own cache of derived values), in a stable order, written the same way
 * where two forms land the same rows: an event stored with its owner at once, or given it by a second statement; the
 * tables' versions bumped in any order.
 */
const gameWrites = (list: string[]) =>
	list
		.filter((w) => !w.includes('engine_derived') && !w.startsWith('UPDATE timeline_events SET player ='))
		.map((w) => {
			const [sql, values] = w.split(' <- ');
			const v = JSON.parse(values) as unknown[];
			if (sql.startsWith('INSERT INTO timeline_events (id, entity, due_at, type, payload, created_at, player)'))
				return `${sql.replace(', player)', ')').replace(', ?)', ')')} <- ${JSON.stringify(v.slice(0, -1))}`;
			if (sql.includes('version = version + 1')) return `${sql} <- ${JSON.stringify([...v].sort())}`;
			return w;
		})
		.sort();

describe('flat commands', () => {
	const setup = async (extraRules: Record<string, unknown> = {}) => {
		const rules = { 'resources.initial': { food: 1e6, wood: 1e6, stone: 1e6, metal: 1e6, gold: 1e6 }, ...extraRules };
		const p = player(rules);
		const c = await p.start();
		const ctx = (now: number, extra: Partial<EngineContext> = {}): EngineContext => ({
			...engineContext(defaultKernel, p.id, now, rules),
			rulesVersion: 1,
			...extra,
		});
		/** Runs a command on `database`, counting how often its flat form went through. */
		const flatRun = async (type: string, database: D1Database, now: number, payload: object, extra: Partial<EngineContext> = {}) => {
			const command = defaultKernel.commands.get(type)!;
			let ran = 0;
			const run = command.flat!.run;
			command.flat!.run = async (input) => {
				const out = await run(input);
				if (out) ran++;
				return out;
			};
			try {
				await executeCommand(defaultKernel, database, ctx(now, extra), type, payload);
			} finally {
				command.flat!.run = run;
			}
			return ran;
		};
		const construct = (database: D1Database, now: number, payload: object, extra: Partial<EngineContext> = {}) =>
			flatRun('buildings.construct', database, now, payload, extra);
		const sync = (now: number) =>
			computeViews(defaultKernel, db, ctx(now), ['buildings.state', 'resources.pool', 'troops.garrison', 'research.state'], {
				settlement: c.id,
			});
		/** Both forms on the same data, writes compared. */
		const same = async (now: number, payload: object, type = 'buildings.construct') => {
			const flat = recorder();
			const ran = await flatRun(type, flat.db, now, payload);
			const regular = recorder();
			await executeCommand(defaultKernel, regular.db, ctx(now, { noFlat: true }), type, payload);
			expect(ran).toBe(1);
			expect(gameWrites(flat.writes)).toEqual(gameWrites(regular.writes));
		};
		return { p, c, ctx, construct, flatRun, sync, same, district: inner(c).id };
	};

	it('buildings.construct: the fast path writes what the regular path writes (new and upgrade), once its values are stored', async () => {
		const { p, c, construct, sync, same, district } = await setup();
		await sync(T0);
		// The page's sync stored what the fast path reads: the first order already takes it.
		expect(await construct(db, T0 + 1_000, { settlement: c.id, district, slot: 1, building: 'warehouse' })).toBe(1);
		await same(T0 + 2_000, { settlement: c.id, district, slot: 0, building: 'warehouse' });
		// The warehouse at slot 1 is done (20 s): its event committed, then its level 2 on the fast path.
		await executeCommand(defaultKernel, db, { ...engineContext(defaultKernel, p.id, T0 + 60_000), rulesVersion: 1 }, 'timeline.settle', {});
		await sync(T0 + 61_000);
		await same(T0 + 62_000, { settlement: c.id, district, slot: 1 });
	});

	it('buildings.construct: its own writes leave what it reads valid (one after another, no page between)', async () => {
		const { c, construct, sync, district } = await setup();
		await sync(T0);
		await construct(db, T0 + 1_000, { settlement: c.id, district, slot: 1, building: 'warehouse' });
		// (The queue holds two.)
		expect(await construct(db, T0 + 2_000, { settlement: c.id, district, slot: 2, building: 'warehouse' })).toBe(1);
	});

	it('buildings.construct: what would be refused goes the regular way and is refused as before', async () => {
		const { p, c, construct, sync, district } = await setup();
		await sync(T0);
		await construct(db, T0 + 1_000, { settlement: c.id, district, slot: 1, building: 'warehouse' });
		// Busy slot, unknown building, someone else's settlement.
		await expect(construct(db, T0 + 2_000, { settlement: c.id, district, slot: 1, building: 'warehouse' })).rejects.toMatchObject({
			code: 'busy',
		});
		await expect(construct(db, T0 + 2_000, { settlement: c.id, district, slot: 4, building: 'nope' })).rejects.toMatchObject({
			code: 'unknown_building',
		});
		const q = player();
		const other = await q.start();
		await expect(
			construct(db, T0 + 2_000, { settlement: other.id, district: inner(other).id, slot: 1, building: 'warehouse' }),
		).rejects.toMatchObject({ status: 404 });
		void p;
	});

	it('troops.train: the fast path writes what the regular path writes (a plain unit, and a levied one using its quota)', async () => {
		const { p, c, ctx, construct, flatRun, sync, same, district } = await setup({ 'starter-army.barracksLevels': { tier2: 1 } });
		await sync(T0);
		await construct(db, T0 + 1_000, { settlement: c.id, district, slot: 1, building: 'barracks' });
		const done = T0 + 3_600_000;
		await executeCommand(defaultKernel, db, ctx(done), 'timeline.settle', {});
		await sync(done + 1_000);
		await same(done + 2_000, { settlement: c.id, unit: 'infantry-1', count: 5 }, 'troops.train');
		// A levied unit: with too little quota the regular way refuses it; with some, both take it the same way.
		await expect(flatRun('troops.train', db, done + 3_000, { settlement: c.id, unit: 'infantry-2', count: 2 })).rejects.toMatchObject({
			code: 'blocked',
		});
		await p.run(done + 4_000, 'items.grant', { item: 'levy-infantry-2', count: 1 }, true);
		await executeCommand(defaultKernel, db, ctx(done + 5_000), 'items.use.levy-infantry-2', null);
		await sync(done + 6_000);
		await same(done + 7_000, { settlement: c.id, unit: 'infantry-2', count: 2 }, 'troops.train');
	});

	it('research.start: the fast path writes what the regular path writes', async () => {
		const { c, ctx, construct, flatRun, sync, same, district } = await setup();
		await sync(T0);
		await construct(db, T0 + 1_000, { settlement: c.id, district, slot: 1, building: 'institute' });
		const done = T0 + 3_600_000;
		await executeCommand(defaultKernel, db, ctx(done), 'timeline.settle', {});
		await sync(done + 1_000);
		await same(done + 2_000, { tech: 'economics', settlement: c.id }, 'research.start');
		// Refused the regular way: an unknown tech, and one tech at a time per settlement.
		await expect(flatRun('research.start', db, done + 3_000, { tech: 'nope', settlement: c.id })).rejects.toMatchObject({
			code: 'unknown_tech',
		});
	});

	it('armies.send: an attack on a camp writes what the regular path writes, once the send form was open', async () => {
		const { p, c, ctx, flatRun, sync, same } = await setup();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 50 }, true);
		const camp = { x: wrap(c.x - 6), y: c.y };
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...camp }, true);
		// As the client: what fell due committed (its alarm), the page synced, the tile's forms opened.
		await executeCommand(defaultKernel, db, ctx(T0 + 1_000), 'timeline.settle', {});
		await sync(T0 + 1_000);
		const form = () =>
			computeViews(defaultKernel, db, ctx(T0 + 1_000), ['forms.patches'], {
				placement: 'tile',
				x: String(camp.x),
				y: String(camp.y),
				settlement: c.id,
			});
		await form();
		await same(T0 + 2_000, { from: c.id, ...camp, units: { 'infantry-1': 10 } }, 'armies.send');
		// One after another, each command's answer (its views: the pool's numbers change with the garrison) between; with a
		// formation chosen too.
		expect(await flatRun('armies.send', db, T0 + 3_000, { from: c.id, ...camp, units: { 'infantry-1': 10 } })).toBe(1);
		await sync(T0 + 3_000);
		expect(
			await flatRun('armies.send', db, T0 + 4_000, {
				from: c.id,
				...camp,
				units: { 'infantry-1': 5 },
				...Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`lane${i}`, 'infantry'])),
			}),
		).toBe(1);
		// Refused the regular way: more troops than there are, the own settlement.
		await expect(flatRun('armies.send', db, T0 + 5_000, { from: c.id, ...camp, units: { 'infantry-1': 500 } })).rejects.toMatchObject({
			code: 'not_enough_units',
		});
		await expect(flatRun('armies.send', db, T0 + 5_000, { from: c.id, x: c.x, y: c.y, units: { 'infantry-1': 1 } })).rejects.toMatchObject({
			code: 'bad_target',
		});
	});

	it('armies.send: with heroes leading, the fast path writes what the regular path writes', async () => {
		const { p, c, ctx, flatRun, sync, same, district } = await setup({ 'buildings.speed': 1e6 });
		await p.construct(T0, c.id, district, 0, 'tavern');
		await p.run(T0 + 1_000, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		const [hero] = (await p.views(T0 + 1_000, ['heroes.list']))['heroes.list'] as { id: string }[];
		await p.run(T0 + 1_000, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 50 }, true);
		const camp = { x: wrap(c.x - 6), y: c.y };
		await p.run(T0 + 1_000, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...camp }, true);
		const at = T0 + 10_000;
		await executeCommand(defaultKernel, db, ctx(at), 'timeline.settle', {});
		await sync(at);
		await computeViews(defaultKernel, db, ctx(at), ['forms.patches'], {
			placement: 'tile',
			x: String(camp.x),
			y: String(camp.y),
			settlement: c.id,
		});
		const order = { from: c.id, ...camp, units: { 'infantry-1': 10 }, hero1: hero.id };
		await same(at + 1_000, order, 'armies.send');
		expect(await flatRun('armies.send', db, at + 2_000, order)).toBe(1);
		// The hero now leads that army: a second one with it is refused the regular way.
		await sync(at + 2_000);
		await expect(flatRun('armies.send', db, at + 3_000, order)).rejects.toMatchObject({ code: 'blocked' });
	});

	it("mail.read: the player's own messages on the fast path write what the regular path writes; the GM's mails go the regular way", async () => {
		const { p, flatRun, same } = await setup();
		const ids = [crypto.randomUUID(), crypto.randomUUID()];
		for (const id of ids)
			await db
				.prepare("INSERT INTO mail_messages (id, player_id, at, kind, title) VALUES (?, ?, ?, 'war-reports.march', 'x')")
				.bind(id, p.id, T0)
				.run();
		await same(T0 + 1_000, { ids }, 'mail.read');
		expect(await flatRun('mail.read', db, T0 + 2_000, { ids: [ids[0]] })).toBe(1);
		const read = await db.prepare('SELECT read FROM mail_messages WHERE id = ?').bind(ids[0]).first<number>('read');
		expect(read).toBe(1);
		// "All" (the GM's mails among them): the regular way.
		expect(await flatRun('mail.read', db, T0 + 3_000, { all: true })).toBe(0);
	});

	it('equipment.equip / unequip: the fast path writes what the regular path writes, once the gear page stored the storage', async () => {
		const { p, c, ctx, flatRun, same, district } = await setup({ 'buildings.speed': 1e6 });
		await p.construct(T0, c.id, district, 0, 'tavern');
		await p.run(T0 + 1_000, 'heroes.recruit', { settlement: c.id, venue: 'tavern', slot: 0 });
		const hero = (await db.prepare('SELECT id FROM heroes_heroes WHERE player_id = ?').bind(p.id).first<string>('id'))!;
		const [base] = defaultKernel.services.get('equipment').bases();
		const piece = crypto.randomUUID();
		await db
			.prepare(
				'INSERT INTO equipment_items (id, player_id, base, slot, tier, rarity, stats, hero_id, settlement_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)',
			)
			.bind(piece, p.id, base.id, base.slot, base.tier, 'white', JSON.stringify({ 'attr.might': 3 }), c.id, T0)
			.run();
		const page = (now: number) => computeViews(defaultKernel, db, ctx(now), ['equipment.items'], { settlement: c.id });
		await page(T0 + 2_000);
		await same(T0 + 3_000, { piece, hero }, 'equipment.equip');
		expect(await flatRun('equipment.equip', db, T0 + 4_000, { piece, hero })).toBe(1);
		expect(await db.prepare('SELECT hero_id FROM equipment_items WHERE id = ?').bind(piece).first<string>('hero_id')).toBe(hero);
		await page(T0 + 5_000);
		await same(T0 + 6_000, { piece }, 'equipment.unequip');
		expect(await flatRun('equipment.unequip', db, T0 + 7_000, { piece })).toBe(1);
		expect(await db.prepare('SELECT settlement_id FROM equipment_items WHERE id = ?').bind(piece).first<string>('settlement_id')).toBe(
			c.id,
		);
		// Someone else's piece: the regular way, refused as before.
		await expect(flatRun('equipment.unequip', db, T0 + 8_000, { piece: crypto.randomUUID() })).rejects.toMatchObject({ code: 'not_found' });
	});
});
