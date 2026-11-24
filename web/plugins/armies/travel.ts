// How long a march takes, worked out in the browser as the server does (src/shared/march.ts; user 2026-11-24: "行军到达
// 时间……前端是知道的呀"): each unit's speed for the player (`armies.speeds`), the slowest one's, raised by the pace
// modifiers other client plugins add (the counterparts of theirs on the server, e.g. carts), over the wrapped distance, by
// the static travel rules (`armies.travel`). Pure: the tests run them against the server's marches.
import type { ArmySent, ArmyMarch, MarchSpeeds, SettlementSummary, UnitCatalog } from '../../../src/shared/api';
import { mapDistance, wrap } from '../../../src/shared/map';
import { type MarchRules, slowestSpeed, travelSeconds } from '../../../src/shared/march';
import type { UiText } from '../../../src/shared/ui';
import { sentCargo, sentFrom, sentUnits } from './sent';

/** A pace modifier's browser counterpart (`armies.addPaceModifier` on the server): null, none; undefined: cannot tell yet. */
export type ClientPaceModifier = (units: Record<string, number>, speedOf: (unit: string) => number) => number | null | undefined;

export interface TravelData {
	speeds: MarchSpeeds;
	rules: MarchRules;
	modifiers: readonly ClientPaceModifier[];
}

/** The missions that go to one's own settlements (faster, no shortest time; the server checks the target is). */
export const ownMissions = new Set(['transfer', 'transport']);

/** One way's seconds of `units` over `distance`, as the server works it out; null: not known here. */
export function marchSeconds(units: Record<string, number>, distance: number, own: boolean, d: TravelData): number | null {
	for (const [u, n] of Object.entries(units)) if (n > 0 && !(u in d.speeds)) return null;
	const slowest = slowestSpeed(units, (u) => d.speeds[u]);
	if (!Number.isFinite(slowest) || slowest <= 0) return null;
	let pace = slowest;
	const speedOf = (u: string) => (units[u] ? (d.speeds[u] ?? 0) : 0);
	for (const m of d.modifiers) {
		const v = m(units, speedOf);
		if (v === undefined) return null;
		if (v !== null && v > pace) pace = v;
	}
	const seconds = travelSeconds(distance, pace, own, d.rules);
	return Number.isFinite(seconds) ? seconds : null;
}

/** What a march takes along and where to. */
export interface SentOrder {
	from: string;
	x: number;
	y: number;
	units: Record<string, number>;
	cargo: Record<string, number>;
}

/** A send payload's order (`from`, `x`, `y`, the units and supplies); null: not one. */
export function orderOf(payload: unknown): SentOrder | null {
	const p = (payload ?? {}) as { x?: unknown; y?: unknown };
	const from = sentFrom(payload);
	const x = Number(p.x);
	const y = Number(p.y);
	if (!from || p.x === undefined || p.y === undefined || !Number.isInteger(x) || !Number.isInteger(y)) return null;
	return { from, x: wrap(x), y: wrap(y), units: sentUnits(payload), cargo: sentCargo(payload) };
}

/**
 * The marches `armies.gather` sends (from its payload: `settlement`, `units`), as the server splits them: the units evenly
 * over the nearest other settlements, each a transport there that fills up. Those so short the server settles them at
 * once (`armies.staged`) left out: what is left is in the order of "armies.sent". Null: not sure of the order (two at the
 * same distance).
 */
export function gatherOrders(payload: unknown, mine: readonly SettlementSummary[], most: number): SentOrder[] | null {
	const from = sentFrom(payload);
	const s = mine.find((x) => x.id === from);
	if (!from || !s) return null;
	const sending = Object.entries(sentUnits(payload));
	const total = sending.reduce((a, [, n]) => a + n, 0);
	const sorted = mine
		.filter((t) => t.id !== s.id)
		.map((t) => ({ t, d: mapDistance(s, t) }))
		.sort((a, b) => a.d - b.d);
	const targets = sorted.slice(0, Math.min(most, total));
	const cut = Math.min(targets.length + 1, sorted.length);
	for (let i = 1; i < cut; i++) if (sorted[i].d === sorted[i - 1].d) return null;
	const out: SentOrder[] = [];
	for (const [i, { t }] of targets.entries()) {
		const share: Record<string, number> = {};
		for (const [u, n] of sending) {
			const k = Math.floor(n / targets.length) + (i < n % targets.length ? 1 : 0);
			if (k > 0) share[u] = k;
		}
		if (Object.keys(share).length) out.push({ from, x: t.x, y: t.y, units: share, cargo: {} });
	}
	return out;
}

/**
 * The march a send made as the server stores it: there and back in the same time, the upkeep of the whole trip paid up
 * front (the units' upkeep in the static `troops.units` x the seconds), sent at `now` (the clock the command ran at).
 */
export function marchOf(
	order: SentOrder,
	sent: ArmySent,
	at: { now: number; seconds: number; mission: string; fromName: UiText; catalog: UnitCatalog },
): ArmyMarch {
	const provisions: Record<string, number> = {};
	for (const [u, n] of Object.entries(order.units))
		for (const [r, perSec] of Object.entries(at.catalog[u]?.upkeep ?? {}))
			provisions[r] = (provisions[r] ?? 0) + perSec * n * (2 * at.seconds);
	const arrivesAt = at.now + at.seconds * 1000;
	return {
		id: sent.id,
		from: order.from,
		target: { x: order.x, y: order.y },
		mission: at.mission,
		phase: 'outbound',
		units: order.units,
		loot: {},
		cargo: order.cargo,
		provisions,
		report: null,
		departedAt: at.now,
		arrivesAt,
		returnsAt: arrivesAt + at.seconds * 1000,
		fromName: at.fromName,
	};
}

/** One way's seconds of an order from its settlement (in `mine`); null: not known here. */
export function orderSeconds(order: SentOrder, mine: readonly SettlementSummary[], own: boolean, d: TravelData): number | null {
	const s = mine.find((x) => x.id === order.from);
	if (!s) return null;
	return marchSeconds(order.units, mapDistance(s, { x: order.x, y: order.y }), own, d);
}
