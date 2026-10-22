/**
 * Commands' fast path (`Command.flat`, docs/development.md §2.3 "快速通道"): on the same data, the flat form must write
 * exactly what the regular `execute` writes. Both are run against a database that reads for real and records the
 * writes instead of making them (so each sees the same state), then the two lists are compared.
 */
import { describe, expect, it } from 'vitest';
import { computeViews, engineContext, executeCommand, type EngineContext } from '../../src/kernel';
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
	const setup = async () => {
		const rules = { 'resources.initial': { food: 1e6, wood: 1e6, stone: 1e6, metal: 1e6, gold: 1e6 } };
		const p = player(rules);
		const c = await p.start();
		const ctx = (now: number, extra: Partial<EngineContext> = {}): EngineContext => ({
			...engineContext(defaultKernel, p.id, now, rules),
			rulesVersion: 1,
			...extra,
		});
		const command = defaultKernel.commands.get('buildings.construct')!;
		/** Runs it on `database`, counting how often the flat form went through. */
		const construct = async (database: D1Database, now: number, payload: object, extra: Partial<EngineContext> = {}) => {
			let ran = 0;
			const run = command.flat!.run;
			command.flat!.run = (input) => {
				const out = run(input);
				if (out) ran++;
				return out;
			};
			try {
				await executeCommand(defaultKernel, database, ctx(now, extra), 'buildings.construct', payload);
			} finally {
				command.flat!.run = run;
			}
			return ran;
		};
		const sync = (now: number) => computeViews(defaultKernel, db, ctx(now), ['buildings.state', 'resources.pool'], { settlement: c.id });
		/** Both forms on the same data, writes compared. */
		const same = async (now: number, payload: object) => {
			const flat = recorder();
			const ran = await construct(flat.db, now, payload);
			const regular = recorder();
			await executeCommand(defaultKernel, regular.db, ctx(now, { noFlat: true }), 'buildings.construct', payload);
			expect(ran).toBe(1);
			expect(gameWrites(flat.writes)).toEqual(gameWrites(regular.writes));
		};
		return { p, c, ctx, construct, sync, same, district: inner(c).id };
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
});
