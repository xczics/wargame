import { it } from 'vitest';
import { computeViews, engineContext } from '../src/kernel';
import { db, T0, defaultKernel, player, inner } from './helpers';

const CITY =
	'settlements.mine,resources.pool,armies.staged,mail.unread,troops.due,armies.due,mail.notice,realms.due,prestige.status,resources.sources,settlements.outline,buildings.state,starter-heroes.posts,items.owned'.split(
		',',
	);

function sending() {
	const out = { sent: [] as string[], calls: 0, db: db as D1Database };
	const wrap = (st: D1PreparedStatement, sql: string): D1PreparedStatement =>
		new Proxy(st, {
			get(t, k) {
				if (k === 'bind') return (...v: unknown[]) => wrap(t.bind(...v), sql);
				if (k === 'all' || k === 'first' || k === 'run' || k === 'raw') (out.sent.push(sql), out.calls++);
				const v = Reflect.get(t, k, t);
				return typeof v === 'function' ? v.bind(t) : v;
			},
		});
	out.db = new Proxy(db, {
		get(target, key) {
			if (key === 'prepare') return (q: string) => wrap(target.prepare(q), q);
			if (key === 'batch')
				return (list: D1PreparedStatement[]) => {
					out.calls++;
					out.sent.push(`BATCH ${list.length}`);
					return target.batch(list);
				};
			const v = Reflect.get(target, key, target);
			return typeof v === 'function' ? v.bind(target) : v;
		},
	});
	return out;
}

it('city sync statements', async () => {
	const p = player({ 'buildings.speed': 1e6, 'resources.initial': { food: 1e6, wood: 1e6, stone: 1e6, metal: 1e6, gold: 1e6 } });
	const c = await p.start();
	await p.construct(T0, c.id, inner(c).id, 0, 'tavern');
	const ctx = { ...engineContext(defaultKernel, p.id, T0 + 3_000), rulesVersion: 1 };
	const params = { settlement: c.id };
	const first = sending();
	const s1 = await computeViews(defaultKernel, first.db, ctx, CITY, params);
	const second = sending();
	const s2 = await computeViews(defaultKernel, second.db, { ...ctx, now: T0 + 4_000 }, CITY, params, [], undefined, s1.stamps ?? {});
	console.log('first', first.calls, '\n  ' + first.sent.join('\n  '));
	console.log('second', second.calls, Object.keys(s2.views), '\n  ' + second.sent.join('\n  '));
});
