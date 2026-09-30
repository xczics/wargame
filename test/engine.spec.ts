/** Unit-of-work semantics of the engine: atomic commits and optimistic-lock retries. */
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createKernel, definePlugin, engineContext, executeCommand, GameError, type Kernel } from '../src/kernel';
import worker from '../src/index';
import { plugins } from '../src/plugins';
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

	it('the NPC upkeep task tops up camps towards the configured population', async () => {
		const count = async () =>
			(await db.prepare("SELECT COUNT(*) AS n FROM settlements_settlements WHERE kind = 'npc-fortress'").first<{ n: number }>())!.n;
		const before = await count();
		await db
			.prepare(
				'INSERT INTO gm_config (key, value, updated_at, updated_by) VALUES (?, ?, 0, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
			)
			.bind('npc-camps.population', JSON.stringify({ 'npc-fortress': before + 3 }), 'test')
			.run();
		await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '* * * * *' }), env);
		expect(await count()).toBe(before + 3);
		await worker.scheduled(createScheduledController({ scheduledTime: Date.now(), cron: '* * * * *' }), env);
		expect(await count()).toBe(before + 3); // already at the target
		await db.prepare("DELETE FROM gm_config WHERE key = 'npc-camps.population'").run();
	});
});
