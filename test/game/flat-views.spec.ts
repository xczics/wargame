/**
 * Views' flat forms (`View.flat`, docs/development.md §2.3 "扁平视图"): on the same data, what a flat form forwards is
 * what the regular compute gives; and it takes over only while nothing of the player's is due.
 */
import { describe, expect, it } from 'vitest';
import { computeViews, engineContext } from '../../src/kernel';
import { wrap } from '../../src/plugins/world-map';
import { db, defaultKernel, inner, outer, player, T0 } from '../helpers';

const flat = defaultKernel.views.filter((v) => v.flat).map((v) => v.id);

describe('flat views', () => {
	it('forward what the regular compute gives (every view with a flat form)', async () => {
		expect(flat).toEqual(expect.arrayContaining(['timeline.due', 'armies.due', 'settlements.mine', 'research.state']));
		const p = player({ 'armies.speed': 1, 'pvp.protectionHours': 0 });
		const c = await p.start();
		await p.run(T0, 'settlements.found', { kind: 'fortress-military', x: wrap(c.x + 6), y: c.y, name: 'Fort' }, true);
		// Someone marching on them, and their own march under way (the alarms have something to say).
		const q = player({ 'armies.speed': 1, 'pvp.protectionHours': 0 });
		const cq = await q.start();
		await q.run(T0, 'troops.grant', { settlement: cq.id, unit: 'infantry-1', count: 5 }, true);
		await q.run(T0, 'armies.send', { from: cq.id, x: c.x, y: c.y, units: { 'infantry-1': 5 } });
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 5 }, true);
		await p.run(T0, 'armies.send', { from: c.id, x: wrap(c.x - 7), y: c.y, units: { 'infantry-1': 2 } });
		const ctx = (noFlat: boolean) => ({ ...engineContext(defaultKernel, p.id, T0 + 1_000, p.overrides), rulesVersion: 1, noFlat });
		// The Tech page's settlement picked (its research options are stored by the regular compute first).
		const at = { settlement: c.id };
		const regular = await computeViews(defaultKernel, db, ctx(true), flat, at);
		// The flat forms answer: the regular computes are not called.
		const called: string[] = [];
		const views = defaultKernel.views.filter((v) => v.flat);
		const computes = views.map((v) => v.compute);
		views.forEach((v, i) => (v.compute = (api, params) => (called.push(v.id), computes[i](api, params))));
		const fast = await computeViews(defaultKernel, db, ctx(false), flat, at).finally(() =>
			views.forEach((v, i) => (v.compute = computes[i])),
		);
		expect(called).toEqual([]);
		expect(fast.views).toEqual(regular.views);
		expect((fast.views['armies.due'] as { items: unknown[] }).items).toHaveLength(1);
		expect((fast.views['settlements.mine'] as unknown[]).length).toBe(2);
	});

	it("step aside while something of the player's is due (they work no events out)", async () => {
		const p = player();
		const c = await p.start();
		await p.run(T0, 'troops.grant', { settlement: c.id, unit: 'infantry-1', count: 5 }, true);
		await p.run(T0, 'armies.send', { from: c.id, x: wrap(c.x - 7), y: c.y, units: { 'infantry-1': 2 } });
		const called: string[] = [];
		const views = defaultKernel.views.filter((v) => v.flat);
		const computes = views.map((v) => v.compute);
		views.forEach((v, i) => (v.compute = (api, params) => (called.push(v.id), computes[i](api, params))));
		// Long after the march arrived (its event due, not yet committed).
		const ctx = { ...engineContext(defaultKernel, p.id, T0 + 3_600_000, p.overrides), rulesVersion: 1 };
		await computeViews(defaultKernel, db, ctx, flat).finally(() => views.forEach((v, i) => (v.compute = computes[i])));
		expect(called.sort()).toEqual([...flat].sort());
	});

	it('forward the Tech page as worked out, with an institute and a research under way', async () => {
		const p = player({ 'buildings.speed': 1e6, 'resources.baseCapacity': 1e9 });
		const c = await p.start();
		for (const r of defaultKernel.services.get('resources').list()) await p.grant(T0, r.id, 1e6);
		await p.construct(T0, c.id, inner(c).id, 0, 'institute');
		await p.run(T0 + 1_000, 'timeline.settle', null);
		await p.run(T0 + 2_000, 'research.start', { tech: 'economics', settlement: c.id });
		const at = { settlement: c.id };
		const ctx = (noFlat: boolean) => ({ ...engineContext(defaultKernel, p.id, T0 + 3_000, p.overrides), rulesVersion: 1, noFlat });
		const regular = await computeViews(defaultKernel, db, ctx(true), ['research.state'], at);
		const state = regular.views['research.state'] as { here: { labs: number; sources?: unknown }; jobs: unknown[] };
		expect(state.here.labs).toBeGreaterThan(0);
		expect(state.jobs).toHaveLength(1);
		const view = defaultKernel.views.find((v) => v.id === 'research.state')!;
		const compute = view.compute;
		let called = 0;
		view.compute = (api, params) => (called++, compute(api, params));
		const fast = await computeViews(defaultKernel, db, ctx(false), ['research.state'], at).finally(() => (view.compute = compute));
		expect(called).toBe(0);
		expect(fast.views).toEqual(regular.views);
	});

	it("forward the City page's buildings, districts and posts after a construction is ordered (their derived values stand)", async () => {
		const p = player({ 'resources.baseCapacity': 1e9 });
		const c = await p.start();
		for (const r of defaultKernel.services.get('resources').list()) await p.grant(T0, r.id, 1e6);
		await p.construct(T0, c.id, outer(c).id, 0, 'farm');
		const at = { settlement: c.id };
		const ids = ['buildings.state', 'settlements.outline', 'starter-heroes.posts', 'heroes.state', 'equipment.items'];
		const ctx = (now: number, noFlat: boolean) => ({ ...engineContext(defaultKernel, p.id, now, p.overrides), rulesVersion: 1, noFlat });
		// The page as the browser had it before (its derived values worked out and stored).
		await computeViews(defaultKernel, db, ctx(T0 + 1_000, true), ids, at);
		await p.construct(T0 + 2_000, c.id, outer(c).id, 1, 'farm');
		const views = defaultKernel.views.filter((v) => ids.includes(v.id));
		const computes = views.map((v) => v.compute);
		const called: string[] = [];
		views.forEach((v, i) => (v.compute = (api, params) => (called.push(v.id), computes[i](api, params))));
		const fast = await computeViews(defaultKernel, db, ctx(T0 + 3_000, false), ids, at).finally(() =>
			views.forEach((v, i) => (v.compute = computes[i])),
		);
		expect(called).toEqual([]);
		const regular = await computeViews(defaultKernel, db, ctx(T0 + 3_000, true), ids, at);
		expect(fast.views).toEqual(regular.views);
		expect((fast.views['buildings.state'] as { construction: unknown[] }).construction).toHaveLength(2);
	});

	it('worked out again when what a stored view read changes (the Army page after founding a fortress)', async () => {
		const p = player({ 'pvp.protectionHours': 0 });
		const c = await p.start();
		const at = { settlement: c.id };
		const ctx = (now: number) => ({ ...engineContext(defaultKernel, p.id, now, p.overrides), rulesVersion: 1 });
		const garrisons = async (now: number) =>
			((await computeViews(defaultKernel, db, ctx(now), ['troops.state'], at)).views['troops.state'] as { garrisons: unknown[] }).garrisons;
		expect(await garrisons(T0 + 1_000)).toHaveLength(1);
		expect(await garrisons(T0 + 2_000)).toHaveLength(1); // read back
		await p.run(T0 + 3_000, 'settlements.found', { kind: 'fortress-military', x: wrap(c.x + 6), y: c.y, name: 'Fort' }, true);
		expect(await garrisons(T0 + 4_000)).toHaveLength(2);
	});

	it('do not read back a derived value stored in an older shape (its salt carries the shape version)', async () => {
		const p = player();
		const c = await p.start();
		const at = { settlement: c.id };
		const ctx = { ...engineContext(defaultKernel, p.id, T0 + 1_000, p.overrides), rulesVersion: 1 };
		await computeViews(defaultKernel, db, ctx, ['research.state'], at);
		// The row as 1.5.2 stored it: no gate reasons, the old salt (2026-10-24: read back, it broke the Tech page).
		await db
			.prepare("UPDATE engine_derived SET salt = '0', value = json_remove(value, '$.reasons', '$.sources') WHERE key = ?")
			.bind(`research:options:${c.id}`)
			.run();
		const state = (await computeViews(defaultKernel, db, ctx, ['research.state'], at)).views['research.state'] as {
			here: { gates: object };
		};
		expect(state.here.gates).toEqual(expect.any(Object));
	});
});
