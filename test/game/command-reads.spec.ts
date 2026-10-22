/**
 * How many D1 calls the heaviest commands make (a batch is one call): reads a command declares up front (`preload`)
 * go together, so the chain of dependent reads gets short (changelog 421).
 */
import { describe, expect, it } from 'vitest';
import { computeViews, engineContext, executeCommand } from '../../src/kernel';
import { wrap } from '../../src/plugins/world-map';
import { db, defaultKernel, files, inner, outer, player, T0 } from '../helpers';

/** The database as D1 sees it: its calls (a batch is one) and the statements in each. */
function calls() {
	const sent: string[] = [];
	// Each call: a statement's SQL, or a batch's size.
	const wrapSt = (s: D1PreparedStatement, sql: string): D1PreparedStatement =>
		new Proxy(s, {
			get(t, k) {
				if (k === 'bind') return (...v: unknown[]) => wrapSt(t.bind(...v), sql);
				if (k === 'all' || k === 'first' || k === 'run' || k === 'raw') sent.push(sql.replace(/\s+/g, ' ').slice(0, 90));
				const v = Reflect.get(t, k, t);
				return typeof v === 'function' ? v.bind(t) : v;
			},
		});
	const counted = new Proxy(db, {
		get(target, key) {
			if (key === 'prepare') return (q: string) => wrapSt(target.prepare(q), q);
			if (key === 'batch') return (list: D1PreparedStatement[]) => (sent.push(`BATCH ${list.length}`), target.batch(list));
			const v = Reflect.get(target, key, target);
			return typeof v === 'function' ? v.bind(target) : v;
		},
	});
	return { sent, db: counted };
}

const freeNear = async (c: { x: number; y: number }, from = 5) => {
	for (let i = from; ; i++) {
		const t = { x: wrap(c.x + i), y: c.y };
		const taken = await db
			.prepare('SELECT 1 FROM world_map_tiles WHERE (x = ? OR x = ? OR x = ?) AND y BETWEEN ? AND ?')
			.bind(wrap(t.x - 1), t.x, wrap(t.x + 1), wrap(t.y - 1), wrap(t.y + 1))
			.first();
		if (!taken) return t;
	}
};

describe('command reads', () => {
	it('the heaviest commands read in a few round trips, not one per read', async () => {
		const p = player({ 'buildings.speed': 1e6, 'resources.baseCapacity': 1e9 });
		const c = await p.start();
		for (const r of defaultKernel.services.get('resources').list()) await p.grant(T0, r.id, 1e7);
		await p.construct(T0, c.id, inner(c).id, 0, 'barracks');
		await p.construct(T0 + 1_000, c.id, inner(c).id, 1, 'institute');
		await p.construct(T0 + 2_000, c.id, outer(c).id, 0, 'farm');
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 500 }, true);
		const fort = await freeNear(c, 4);
		await p.run(T0, 'settlements.found', { kind: 'fortress-resource', ...fort, name: 'Mine' }, true);
		const camp = { x: wrap(c.x - 6), y: c.y };
		await p.run(T0, 'npc-camps.spawnAt', { kind: 'npc-outpost', ...camp }, true);
		await p.run(T0, 'items.grant', { item: 'recruit-edict', count: 2 }, true);
		let at = T0 + 10_000;
		const run = async (type: string, payload: unknown) => {
			at += 1_000;
			const ctx = { ...engineContext(defaultKernel, p.id, at, p.overrides), files, rulesVersion: 1 };
			// As the client: what fell due committed (its alarm's `timeline.settle`), then the city page synced (the
			// settlements' production numbers and building options stored: what the fast path of `buildings.construct` reads).
			await executeCommand(defaultKernel, db, ctx, 'timeline.settle', {});
			for (const s of await p.mine(at))
				await computeViews(defaultKernel, db, ctx, ['resources.pool', 'buildings.state', 'troops.garrison'], { settlement: s.id });
			const { sent, db: counted } = calls();
			await executeCommand(defaultKernel, counted, ctx, type, payload);
			return sent.length;
		};
		const n = {
			transport: await run('armies.transport', { from: c.id, ...fort, units: { 'infantry-1': 10 }, cargo: { food: 10 } }),
			attack: await run('armies.send', { from: c.id, ...camp, units: { 'infantry-1': 10 } }),
			upgrade: await run('buildings.construct', { settlement: c.id, district: outer(c).id, slot: 0 }),
			construct: await run('buildings.construct', { settlement: c.id, district: outer(c).id, slot: 1, building: 'farm' }),
			train: await run('troops.train', { settlement: c.id, unit: 'infantry-1', count: 5 }),
			research: await run('research.start', { tech: 'economics', settlement: c.id }),
			item: await run('items.use.recruit-edict', null),
		};
		// Before preloading (2026-10-21): 27, 16, 16, 15, 17, 17, 5 calls; the statements about the same.
		// 2026-10-22: with due events committed first (as the client does) and the city page synced, `buildings.construct`
		// takes its fast path: one batch of reads, one of writes.
		const budget = { transport: 8, attack: 4, upgrade: 2, construct: 2, train: 2, research: 4, item: 6 };
		for (const [k, most] of Object.entries(budget)) expect(n[k as keyof typeof n], k).toBeLessThanOrEqual(most);
	});
});
