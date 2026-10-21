/** Unit-of-work semantics of the engine: atomic commits and optimistic-lock retries. */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import {
	computeViews,
	createKernel,
	definePlugin,
	engineContext,
	executeCommand,
	GameError,
	playerStamp,
	type Kernel,
	readRecord,
} from '../src/kernel';
import { coalesce, recording } from '../src/kernel/coalesce';
import { packReads } from '../src/kernel/pack';
import worker from '../src/index';
import { plugins } from '../src/plugins';
import { bucketFiles } from '../src/runtime/files';
import { d1Calls } from './helpers';

const files = bucketFiles(env.FILES);
import { createScheduledController } from 'cloudflare:test';

const db = env.DB;
const noop = () => db.prepare('SELECT 1');

describe('engine', () => {
	it('retries a command when another commit for the same player lands in between', async () => {
		let attempts = 0;
		const kernel: Kernel = createKernel([
			definePlugin({
				id: 't',
				version: '0',
				setup(c) {
					c.commands.add({ type: 't.inner', parse: () => null, execute: async (api) => api.write(noop()) });
					c.commands.add({
						type: 't.outer',
						parse: () => null,
						async execute(api) {
							attempts++;
							// Simulate a concurrent request committing after we read our lock version.
							if (attempts === 1) await executeCommand(kernel, db, engineContext(kernel, api.playerId, api.now), 't.inner', null);
							api.write(noop());
						},
					});
				},
			}),
		]);
		const ctx = engineContext(kernel, crypto.randomUUID(), 0);
		await executeCommand(kernel, db, ctx, 't.outer', null);
		expect(attempts).toBe(2);
	});

	it('api.version: how many commits locked an entity, the same until the next one (a view stamp)', async () => {
		const seen: number[] = [];
		const kernel: Kernel = createKernel([
			definePlugin({
				id: 't',
				version: '0',
				setup(c) {
					c.commands.add({ type: 't.write', parse: () => null, execute: async (api) => api.write(noop()) });
					c.commands.add({ type: 't.read', parse: () => null, execute: async () => {} });
					c.views.add({ id: 't.version', compute: async (api) => void seen.push(await api.version(`player:${api.playerId}`)) });
				},
			}),
		]);
		const ctx = engineContext(kernel, crypto.randomUUID(), 0);
		const look = () => computeViews(kernel, db, ctx, ['t.version'], {});
		await look();
		await executeCommand(kernel, db, ctx, 't.write', null);
		await look();
		await executeCommand(kernel, db, ctx, 't.read', null); // writes nothing: no commit
		await look();
		expect(seen).toEqual([0, 1, 1]);
	});

	it("touch: another player's record moves on with the commit, unlocked; a command of theirs meanwhile is retried", async () => {
		let attempts = 0;
		const other = crypto.randomUUID();
		const kernel: Kernel = createKernel([
			definePlugin({
				id: 't',
				version: '0',
				setup(c) {
					c.commands.add({
						type: 't.touch',
						parse: () => null,
						execute: async (api) => (
							api.touch(`player:${other}`),
							api.write(
								api.db.prepare('INSERT INTO pack_t (id, v) VALUES (?, 1)').bind(Date.now() * 1000 + Math.floor(Math.random() * 1000)),
							)
						),
					});
					c.commands.add({
						type: 't.own',
						parse: () => null,
						async execute(api) {
							attempts++;
							if (attempts === 1) await executeCommand(kernel, db, engineContext(kernel, crypto.randomUUID(), 0), 't.touch', null);
							api.write(noop());
						},
					});
					c.views.add({ id: 't.record', compute: async () => null });
				},
			}),
		]);
		await db.prepare('CREATE TABLE IF NOT EXISTS pack_t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)').run();
		const record = () => readRecord(kernel, db, other, 0);
		expect((await record()).version).toBe(0);
		await executeCommand(kernel, db, engineContext(kernel, crypto.randomUUID(), 0), 't.touch', null);
		expect(await record()).toMatchObject({ playerId: other, version: 1, due: false });
		// Their table version too (a stamp by the tables read sees it).
		const row = await db.prepare('SELECT version FROM engine_locks WHERE entity = ?').bind(`player:${other}#pack_t`).first('version');
		expect(row).toBe(1);
		// Their own command, with a touch landing after it read its lock: retried, then committed.
		await executeCommand(kernel, db, engineContext(kernel, other, 0), 't.own', null);
		expect(attempts).toBe(2);
		expect((await record()).version).toBe(3);
	});

	it('a stamp holds only under the same parameters', async () => {
		let computed = 0;
		const kernel: Kernel = createKernel([
			definePlugin({
				id: 't',
				version: '0',
				setup(c) {
					c.views.add({ id: 't.stamped', stamp: async () => 'same', compute: async () => ++computed });
				},
			}),
		]);
		const ctx = engineContext(kernel, crypto.randomUUID(), 0);
		const first = await computeViews(kernel, db, ctx, ['t.stamped'], { hero: 'a' });
		const held = first.stamps!;
		expect((await computeViews(kernel, db, ctx, ['t.stamped'], { hero: 'a' }, [], undefined, held)).views).toEqual({});
		expect((await computeViews(kernel, db, ctx, ['t.stamped'], { hero: 'b' }, [], undefined, held)).views).toEqual({ 't.stamped': 2 });
	});

	it('putFile: files go to the object storage with the commit, never with a rejected command; views read them', async () => {
		const key = `t/${crypto.randomUUID()}.txt`;
		const read: (string | null)[] = [];
		const kernel: Kernel = createKernel([
			definePlugin({
				id: 't',
				version: '0',
				setup(c) {
					c.commands.add({
						type: 't.store',
						parse: (p) => p as { fail: boolean },
						async execute(api, p) {
							api.putFile(key, 'hello', { contentType: 'text/plain' });
							api.write(noop());
							if (p.fail) throw new GameError('nope', 'Rejected');
						},
					});
					c.views.add({ id: 't.read', compute: async (api) => void read.push((await api.files?.get(key)) ?? null) });
				},
			}),
		]);
		const ctx = { ...engineContext(kernel, crypto.randomUUID(), 0), files };
		await expect(executeCommand(kernel, db, ctx, 't.store', { fail: true })).rejects.toThrow('Rejected');
		expect(await env.FILES.head(key)).toBeNull();
		await executeCommand(kernel, db, ctx, 't.store', { fail: false });
		expect((await env.FILES.head(key))?.httpMetadata?.contentType).toBe('text/plain');
		await computeViews(kernel, db, ctx, ['t.read'], {});
		expect(read).toEqual(['hello']);
		// Without object storage it is a wiring error, not a player-facing one.
		await expect(executeCommand(kernel, db, engineContext(kernel, crypto.randomUUID(), 0), 't.store', { fail: false })).rejects.toThrow(
			'No file storage',
		);
	});

	it('commits all writes or none', async () => {
		const id = crypto.randomUUID();
		const kernel = createKernel([
			definePlugin({
				id: 't',
				version: '0',
				setup(c) {
					c.commands.add({
						type: 't.half',
						parse: () => null,
						async execute(api) {
							api.write(
								db
									.prepare('INSERT INTO buildings_slots (district_id, slot, settlement_id, building, level) VALUES (?, 0, ?, ?, 1)')
									.bind(id, id, 'x'),
							);
							api.write(
								db
									.prepare('INSERT INTO buildings_slots (district_id, slot, settlement_id, building, level) VALUES (?, 1, ?, ?, -1)')
									.bind(id, id, 'y'),
							); // violates CHECK
						},
					});
					c.commands.add({
						type: 't.reject',
						parse: () => null,
						execute: async () => {
							throw new GameError('nope', 'no');
						},
					});
				},
			}),
		]);
		await expect(executeCommand(kernel, db, engineContext(kernel, id, 0), 't.half', null)).rejects.toThrow();
		const row = await db.prepare('SELECT COUNT(*) AS n FROM buildings_slots WHERE settlement_id = ?').bind(id).first<{ n: number }>();
		expect(row?.n).toBe(0);
		await expect(executeCommand(kernel, db, engineContext(kernel, id, 0), 't.reject', null)).rejects.toThrow(GameError);
	});

	it('the cron sweep processes due events nobody looked at', async () => {
		const kernel = createKernel(plugins);
		const id = crypto.randomUUID();
		const past = Date.now() - 60_000; // a build started a minute ago finished 50 s ago
		const ctx = (now: number) => engineContext(kernel, id, now);
		await executeCommand(kernel, db, ctx(past), 'settlements.foundCapital', null);
		const s = await db.prepare('SELECT id FROM settlements_settlements WHERE owner_id = ?').bind(id).first<{ id: string }>();
		const d = await db
			.prepare("SELECT id FROM settlements_districts WHERE settlement_id = ? AND type = 'outer'")
			.bind(s!.id)
			.first<{ id: string }>();
		await executeCommand(kernel, db, ctx(past), 'buildings.construct', { settlement: s!.id, district: d!.id, slot: 0, building: 'farm' });

		await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '* * * * *' }), env);
		const slot = await db.prepare('SELECT level FROM buildings_slots WHERE district_id = ?').bind(d!.id).first<{ level: number }>();
		expect(slot?.level).toBe(1);
		const pending = await db
			.prepare('SELECT COUNT(*) AS n FROM timeline_events WHERE entity = ?')
			.bind(`settlement:${s!.id}`)
			.first<{ n: number }>();
		expect(pending?.n).toBe(0);
	});
});

describe('packed reads', () => {
	it('sends reads issued together as one batch, each answered with its own rows', async () => {
		await db.prepare('CREATE TABLE IF NOT EXISTS pack_t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)').run();
		await db.prepare('DELETE FROM pack_t').run();
		await db.prepare('INSERT INTO pack_t (id, v) VALUES (1, 10), (2, 20), (3, 30)').run();
		const { sent, db: counted } = d1Calls();
		const packed = packReads(counted);
		expect(packReads(packed)).toBe(packed);
		const q = (id: number) => packed.prepare('SELECT v FROM pack_t WHERE id = ?').bind(id);
		// One a few awaits later still goes with the others (views reach their first read after a hop or two).
		const later = (async () => {
			await null;
			await null;
			return q(3).first<number>('v');
		})();
		const [one, two, all, three, none] = await Promise.all([
			q(1).first<{ v: number }>(),
			q(2).first<number>('v'),
			packed.prepare('SELECT id FROM pack_t ORDER BY id').all<{ id: number }>(),
			later,
			q(9).first(),
		]);
		expect(one).toEqual({ v: 10 });
		expect(two).toBe(20);
		expect(all.results.map((r) => r.id)).toEqual([1, 2, 3]);
		expect(three).toBe(30);
		expect(none).toBeNull();
		expect(sent).toEqual([5]);
	});

	it('never lets a write overtake a read issued before it; a failing read fails alone', async () => {
		await db.prepare('CREATE TABLE IF NOT EXISTS pack_t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)').run();
		await db.prepare('DELETE FROM pack_t').run();
		const packed = packReads(db);
		const before = packed.prepare('SELECT COUNT(*) AS n FROM pack_t').first<number>('n');
		await packed.prepare('INSERT INTO pack_t (id, v) VALUES (1, 1)').run();
		expect(await before).toBe(0);
		expect(await packed.prepare('SELECT COUNT(*) AS n FROM pack_t').first<number>('n')).toBe(1);

		const good = packed.prepare('SELECT v FROM pack_t WHERE id = 1').first<number>('v');
		const bad = packed.prepare('SELECT nope FROM pack_t').all();
		await expect(bad).rejects.toThrow();
		expect(await good).toBe(1);
	});
});

describe('coalescing writes', () => {
	it('merges single-row inserts into one table, keeps each table in order, fits the parameter limit', async () => {
		await db.prepare('CREATE TABLE IF NOT EXISTS coalesce_t (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)').run();
		await db.prepare('CREATE TABLE IF NOT EXISTS coalesce_u (id INTEGER PRIMARY KEY, v INTEGER NOT NULL)').run();
		const r = recording(db);
		const ins = (t: string, id: number, v: number) => r.prepare(`INSERT INTO ${t} (id, v) VALUES (?, ?)`).bind(id, v);
		const upsert = (id: number, v: number) =>
			r.prepare('INSERT INTO coalesce_t (id, v) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET v = excluded.v').bind(id, v);
		const list = [
			...Array.from({ length: 60 }, (_, i) => ins('coalesce_t', 1000 + i, i)), // 120 parameters: two statements
			ins('coalesce_u', 1, 1), // another table: does not stop the run
			ins('coalesce_t', 2000, 1),
			r.prepare('UPDATE coalesce_t SET v = v + 100 WHERE id = 2000'), // its table: later inserts stay after it
			ins('coalesce_t', 2001, 1),
			upsert(2001, 7), // other SQL (ON CONFLICT): its own statement, after the insert it updates
		];
		const out = coalesce(r, list);
		expect(out).toHaveLength(6);
		await db.batch(out);
		const rows = await db.prepare('SELECT id, v FROM coalesce_t WHERE id >= 2000 ORDER BY id').all();
		expect(rows.results).toEqual([
			{ id: 2000, v: 101 },
			{ id: 2001, v: 7 },
		]);
		expect((await db.prepare('SELECT COUNT(*) AS n FROM coalesce_t WHERE id BETWEEN 1000 AND 1059').first<{ n: number }>())!.n).toBe(60);
		// Statements not made through `recording` stay put and close every run.
		expect(coalesce(r, [ins('coalesce_t', 3000, 1), db.prepare('SELECT 1'), ins('coalesce_t', 3001, 1)])).toHaveLength(3);
	});
});

describe('stamps by the tables a view read', () => {
	const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
	const A = `stampa_${suffix}`;
	const B = `stampb_${suffix}`;
	let seeded = Promise.withResolvers<void>();
	const kernel = createKernel([
		definePlugin({
			id: 's',
			version: '0',
			setup(c) {
				const rowsOf = (api: import('../src/kernel').ReadApi) =>
					api.memo('s:a', async () => (await api.db.prepare(`SELECT k FROM ${A} ORDER BY k`).all<{ k: string }>()).results.map((r) => r.k));
				// Reads A itself; reads B; reads A only through a memo another view may have loaded first.
				c.views.add({ id: 's.a', stamp: playerStamp, compute: rowsOf });
				c.views.add({
					id: 's.b',
					stamp: playerStamp,
					compute: async (api) => (await api.db.prepare(`SELECT COUNT(*) AS n FROM ${B}`).first<number>('n')) ?? 0,
				});
				c.views.add({ id: 's.viaMemo', stamp: playerStamp, compute: async (api) => (await rowsOf(api)).length });
				// A memo filled with rows read before it (no statement of its own), used by another view.
				c.views.add({
					id: 's.seeded',
					stamp: playerStamp,
					compute: async (api) => {
						await api.db.prepare(`SELECT 1 FROM ${A} LIMIT 1`).first();
						void api.memo('s:seed', async () => 'seeded');
						seeded.resolve();
						return 1;
					},
				});
				// After the seeding (side by side, it could otherwise come first and load its own value).
				c.views.add({
					id: 's.usesSeed',
					stamp: playerStamp,
					compute: async (api) => (await seeded.promise, api.memo('s:seed', async () => 'own')),
				});
				for (const t of [A, B])
					c.commands.add<string>({
						type: `s.add-${t === A ? 'a' : 'b'}`,
						parse: (raw) => raw as string,
						execute: async (api, k) => api.write(api.db.prepare(`INSERT INTO ${t} (k) VALUES (?)`).bind(k)),
					});
				// A write the engine cannot read the table of (not prepared through the api).
				c.commands.add({ type: 's.raw', parse: () => null, execute: async (api) => api.write(db.prepare('SELECT 1')) });
			},
		}),
	]);
	const ids = ['s.a', 's.b', 's.viaMemo', 's.seeded', 's.usesSeed'];

	it('a command leaves out the views that read none of the tables it wrote; a memo counts for every view using it', async () => {
		await db.batch([db.prepare(`CREATE TABLE ${A} (k TEXT PRIMARY KEY)`), db.prepare(`CREATE TABLE ${B} (k TEXT PRIMARY KEY)`)]);
		const playerId = crypto.randomUUID();
		const ctx = () => engineContext(kernel, playerId, 0);
		const run = (type: string, payload: unknown) => executeCommand(kernel, db, ctx(), type, payload);
		let held = (await computeViews(kernel, db, ctx(), ids)).stamps!;
		const sent = async () => {
			seeded = Promise.withResolvers<void>();
			const out = await computeViews(kernel, db, ctx(), ids, {}, [], undefined, held);
			held = { ...held, ...out.stamps };
			return Object.keys(out.views).sort();
		};
		expect(await sent()).toEqual([]); // nothing changed
		await run('s.add-b', 'x');
		expect(await sent()).toEqual(['s.b']);
		await run('s.add-a', 'x');
		expect(await sent()).toEqual(['s.a', 's.seeded', 's.usesSeed', 's.viaMemo']);
		// The commit moved on the player's version of the table written (and their lock version, as before).
		const { results } = await db
			.prepare('SELECT entity, version FROM engine_locks WHERE entity > ? AND entity < ? ORDER BY entity')
			.bind(`player:${playerId}#`, `player:${playerId}$`)
			.all();
		expect(results).toEqual([
			{ entity: `player:${playerId}#${A}`, version: 1 },
			{ entity: `player:${playerId}#${B}`, version: 1 },
		]);
		// Another player's commit moves on nothing of theirs.
		await executeCommand(kernel, db, engineContext(kernel, crypto.randomUUID(), 0), 's.add-a', 'y');
		expect(await sent()).toEqual([]);
		// A write of an unknown table counts for every view.
		await run('s.raw', null);
		expect(await sent()).toEqual(ids.slice().sort());
	});

	it('views a command hands its memos to note their tables too (stamps after a command)', async () => {
		const playerId = crypto.randomUUID();
		const ctx = () => engineContext(kernel, playerId, 0);
		const first = await computeViews(kernel, db, ctx(), ids);
		const { carried } = await executeCommand(kernel, db, ctx(), 's.add-b', crypto.randomUUID());
		const after = await computeViews(kernel, db, ctx(), ids, {}, [], carried, first.stamps);
		expect(Object.keys(after.views)).toEqual(['s.b']);
		expect(after.stamps!['s.a']).toBe(first.stamps!['s.a']);
	});
});

describe('derived values (stored, read back while their tables stand)', () => {
	const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 8);
	const SRC = `derived_src_${suffix}`;
	const OTHER = `derived_other_${suffix}`;
	let worked = 0;
	const kernel = createKernel([
		definePlugin({
			id: 'd',
			version: '0',
			setup(c) {
				const total = (api: import('../src/kernel').ReadApi) =>
					api.derived(`d:total:${api.playerId}`, { owner: api.playerId }, async () => {
						worked++;
						return { n: (await api.db.prepare(`SELECT COUNT(*) AS n FROM ${SRC}`).first<number>('n')) ?? 0 };
					});
				c.views.add({ id: 'd.total', stamp: playerStamp, compute: total });
				c.commands.add<string>({
					type: 'd.add',
					parse: (raw) => raw as string,
					async execute(api, k) {
						await total(api);
						api.write(api.db.prepare(`INSERT INTO ${SRC} (k) VALUES (?)`).bind(k));
						await total(api); // after its own write: worked out again, not the stored one
					},
				});
				c.commands.add<string>({
					type: 'd.other',
					parse: (raw) => raw as string,
					execute: async (api, k) => api.write(api.db.prepare(`INSERT INTO ${OTHER} (k) VALUES (?)`).bind(k)),
				});
				c.commands.add({ type: 'd.read', parse: () => null, execute: async (api) => void (await total(api)) });
			},
		}),
	]);

	it('is worked out once and stored, read back until a command writes one of its tables', async () => {
		await db.batch([db.prepare(`CREATE TABLE ${SRC} (k TEXT PRIMARY KEY)`), db.prepare(`CREATE TABLE ${OTHER} (k TEXT PRIMARY KEY)`)]);
		const playerId = crypto.randomUUID();
		const ctx = () => ({ ...engineContext(kernel, playerId, 0), rulesVersion: 1 });
		const view = async () => (await computeViews(kernel, db, ctx(), ['d.total'])).views['d.total'] as { n: number };
		const run = (type: string, payload: unknown) => executeCommand(kernel, db, ctx(), type, payload);
		const stored = async () =>
			JSON.parse(
				(await db.prepare('SELECT value FROM engine_derived WHERE key = ?').bind(`d:total:${playerId}`).first<string>('value')) ?? 'null',
			);

		worked = 0;
		expect(await view()).toEqual({ n: 0 });
		expect(worked).toBe(1);
		expect(await stored()).toEqual({ n: 0 }); // worked out from what is committed: stored (views too)
		expect(await view()).toEqual({ n: 0 });
		await run('d.read', null);
		await run('d.other', 'a'); // writes another table: the stored one stands
		expect(await view()).toEqual({ n: 0 });
		expect(worked).toBe(1); // read back every time since
		// A command writing its table works it out again after the write (not stored: it is not committed yet) ...
		await run('d.add', 'x');
		expect(worked).toBe(2);
		expect(await stored()).toEqual({ n: 0 }); // the old row, now disagreeing with the versions
		// ... and the next call works it out from the commit and stores it.
		expect(await view()).toEqual({ n: 1 });
		expect(worked).toBe(3);
		expect(await stored()).toEqual({ n: 1 });
		expect(await view()).toEqual({ n: 1 });
		expect(worked).toBe(3);
		// Another rules version: worked out again.
		expect((await computeViews(kernel, db, { ...ctx(), rulesVersion: 2 }, ['d.total'])).views['d.total']).toEqual({ n: 1 });
		expect(worked).toBe(4);
		// No rules version (engine tests' contexts): worked out every time, never stored.
		await computeViews(kernel, db, engineContext(kernel, playerId, 0), ['d.total']);
		expect(worked).toBe(5);
	});

	it('counts for the stamp of a view reading it back (the view is sent again when its tables change)', async () => {
		const playerId = crypto.randomUUID();
		const ctx = () => ({ ...engineContext(kernel, playerId, 0), rulesVersion: 1 });
		await executeCommand(kernel, db, ctx(), 'd.add', crypto.randomUUID());
		const first = await computeViews(kernel, db, ctx(), ['d.total']);
		await executeCommand(kernel, db, ctx(), 'd.add', crypto.randomUUID());
		const again = await computeViews(kernel, db, ctx(), ['d.total'], {}, [], undefined, first.stamps);
		expect(again.views['d.total']).toEqual({ n: (first.views['d.total'] as { n: number }).n + 1 });
	});
});
