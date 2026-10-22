/**
 * `buildings.construct` (upgrade the building in a slot) done by hand, for `/api/_bench/raw/buildings.construct`: the
 * same tables read as the real command reads them (its first batch, see `test/bench.spec.ts`), the same arithmetic
 * (the shared cost formula, resources advanced at their stored rate), and the same writes as no-op UPDATEs (`WHERE 0`),
 * all in one batch as the engine commits. No kernel, no engine, no memo, no hooks, no stats: what is left when all the
 * machinery is taken away, to compare with the real command run through the engine in a dry run.
 *
 * A diagnostic, not a game path: it reads other plugins' tables directly (AGENTS.md forbids that for game code), only
 * this player's rows, and writes nothing. Bonuses (research, heroes, construction speed, storage caps) are not
 * applied: the content's numbers stand, so its cost may differ from the real one; the work is what is compared.
 */
import { levelCost, type BuildingPlan } from '../../shared/buildings';

/** The rules the command uses (the content's, as precompiled data would have them). */
export interface ConstructRules {
	plans: Record<
		string,
		Pick<BuildingPlan, 'levels' | 'costGrowth' | 'timeGrowth' | 'produces' | 'lateCostFrom' | 'lateCostGrowth' | 'cap'>
	>;
	speed: number;
	ownResourceFreeUntil: number;
	queueSize: number;
}

export interface ConstructTarget {
	settlement: string;
	district: string;
	slot: number;
}

export type RawResult =
	| { ok: true; building: string; toLevel: number; cost: Record<string, number>; seconds: number; due: number; statements: number }
	| { ok: false; error: string };

export async function rawConstruct(
	db: D1Database,
	playerId: string,
	now: number,
	t: ConstructTarget,
	rules: ConstructRules,
): Promise<RawResult> {
	const player = `player:${playerId}`;
	const holder = `settlement:${t.settlement}`;
	const q = (sql: string, ...values: unknown[]) => db.prepare(sql).bind(...values);
	// One round trip, as the real command's first batch (lock, rules, the settlement and what is kept for it).
	const [lock, rulesRow, settlement, districts, slots, building, pool, due] = await db.batch([
		q('SELECT version FROM engine_locks WHERE entity = ?', player),
		db.prepare('SELECT version FROM gm_config_version WHERE id = 1'),
		q('SELECT id, kind, owner_id FROM settlements_settlements WHERE id = ?', t.settlement),
		q('SELECT id, slots, extra_slots FROM settlements_districts WHERE settlement_id = ?', t.settlement),
		q('SELECT district_id, slot, building, level, cap FROM buildings_slots WHERE settlement_id = ?', t.settlement),
		q('SELECT district_id, slot FROM buildings_construction WHERE settlement_id = ?', t.settlement),
		q('SELECT resource, amount, rate, updated_at FROM resources_balances WHERE holder = ?', holder),
		q('SELECT id FROM timeline_events WHERE entity = ? AND due_at <= ?', holder, now),
		q('SELECT tech, level FROM research_levels WHERE player_id = ?', playerId),
		q('SELECT unit, count FROM troops_garrison WHERE settlement_id = ?', t.settlement),
		q('SELECT percent, until FROM starter_items_boosts WHERE settlement_id = ?', t.settlement),
		q('SELECT version, codes FROM terrain_settlements WHERE settlement_id = ?', t.settlement),
		q('SELECT value, best, recent, recent_at FROM prestige_players WHERE player_id = ?', playerId),
	]);
	const s = settlement.results[0] as { owner_id: string | null } | undefined;
	if (!s || s.owner_id !== playerId) return { ok: false, error: 'not_found' };
	const d = (districts.results as { id: string; slots: number; extra_slots: number | null }[]).find((x) => x.id === t.district);
	if (!d || t.slot < 0 || t.slot >= d.slots + (d.extra_slots ?? 0)) return { ok: false, error: 'bad_slot' };
	const placed = (slots.results as { district_id: string; slot: number; building: string; level: number; cap: number | null }[]).find(
		(x) => x.district_id === t.district && x.slot === t.slot,
	);
	if (!placed) return { ok: false, error: 'empty_slot' };
	const building_ = building.results as { district_id: string; slot: number }[];
	if (building_.some((c) => c.district_id === t.district && c.slot === t.slot)) return { ok: false, error: 'busy' };
	if (building_.length >= rules.queueSize) return { ok: false, error: 'queue_full' };
	const plan = rules.plans[placed.building];
	if (!plan) return { ok: false, error: 'unknown_building' };
	const toLevel = placed.level + 1;
	if (toLevel > (placed.cap ?? plan.cap)) return { ok: false, error: 'cap' };
	const { cost, seconds } = levelCost(plan, toLevel, rules);

	// Settle: what accrued since each pool was last written, at the rate stored with it; then pay.
	const balances = new Map<string, { amount: number; rate: number }>();
	for (const r of pool.results as { resource: string; amount: number; rate: number; updated_at: number }[])
		balances.set(r.resource, { amount: r.amount + (r.rate * Math.max(0, now - r.updated_at)) / 1000, rate: r.rate });
	for (const [res, n] of Object.entries(cost)) {
		const b = balances.get(res);
		if (!b || b.amount < n) return { ok: false, error: 'not_enough' };
		b.amount -= n;
	}
	const finishesAt = now + seconds * 1000;
	const version = (lock.results[0] as { version: number } | undefined)?.version ?? 0;
	void rulesRow;

	// The commit: the real command's writes, each as a no-op (nothing matches `WHERE 0`), in one batch.
	const writes = [
		q('UPDATE engine_locks SET version = ? WHERE 0 AND entity = ?', version + 1, player),
		q(
			'UPDATE engine_locks SET version = version + 1 WHERE 0 AND entity IN (?, ?, ?, ?)',
			`${player}#buildings_construction`,
			`${player}#timeline_events`,
			`${player}#resources_balances`,
			`${player}#engine_derived`,
		),
		q(
			'UPDATE buildings_construction SET building = ?, target_level = ?, started_at = ?, finishes_at = ? WHERE 0 AND district_id = ? AND slot = ? AND settlement_id = ?',
			placed.building,
			toLevel,
			now,
			finishesAt,
			t.district,
			t.slot,
			t.settlement,
		),
		q(
			'UPDATE timeline_events SET entity = ?, due_at = ?, type = ?, payload = ?, created_at = ? WHERE 0 AND id = ?',
			holder,
			finishesAt,
			'buildings.complete',
			JSON.stringify({ settlementId: t.settlement, districtId: t.district, slot: t.slot, building: placed.building, level: toLevel }),
			now,
			crypto.randomUUID(),
		),
		q(
			'UPDATE timeline_events SET player = (SELECT owner_id FROM settlements_settlements WHERE id = substr(timeline_events.entity, 12)) WHERE 0 AND id = ?',
			crypto.randomUUID(),
		),
		...[...balances].map(([res, b]) =>
			q(
				'UPDATE resources_balances SET amount = ?, rate = ?, updated_at = ? WHERE 0 AND holder = ? AND resource = ?',
				b.amount,
				b.rate,
				now,
				holder,
				res,
			),
		),
	];
	await db.batch(writes);
	return { ok: true, building: placed.building, toLevel, cost, seconds, due: due.results.length, statements: 13 + writes.length };
}
