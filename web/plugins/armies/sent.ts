// What sending troops did (every command that sends an army: attack, transfer, transport, gathering, founding,
// uprooting), applied to the player's data held in the browser (user 2026-11-20: "你告诉前端成功了，前端不就能更新了吗？"):
// the troops are gone from their garrison on every page, the heroes leading them on duty, the march itself in the
// marches held. Pure: the tests run them.
import type { ArmyMarch, ArmySent, UnitCatalog } from '../../../src/shared/api';
import type { UiText } from '../../../src/shared/ui';

/** The troops a send payload took from its settlement (`units` as a record, or the form's "units.<id>" boxes). */
export function sentUnits(payload: unknown): Record<string, number> {
	const p = (payload ?? {}) as Record<string, unknown>;
	const out: Record<string, number> = {};
	const add = (u: string, n: unknown) => {
		const v = Number(n);
		if (Number.isFinite(v) && v > 0) out[u] = (out[u] ?? 0) + Math.floor(v);
	};
	if (p.units && typeof p.units === 'object') for (const [u, n] of Object.entries(p.units as Record<string, unknown>)) add(u, n);
	else for (const [k, n] of Object.entries(p)) if (k.startsWith('units.')) add(k.slice('units.'.length), n);
	return out;
}

/** The supplies a send payload carries (`cargo` as a record, or the form's "cargo.<id>" boxes). */
export function sentCargo(payload: unknown): Record<string, number> {
	const p = (payload ?? {}) as Record<string, unknown>;
	const out: Record<string, number> = {};
	const add = (r: string, n: unknown) => {
		const v = Number(n);
		if (Number.isFinite(v) && v > 0) out[r] = (out[r] ?? 0) + v;
	};
	if (p.cargo && typeof p.cargo === 'object') for (const [r, n] of Object.entries(p.cargo as Record<string, unknown>)) add(r, n);
	else for (const [k, n] of Object.entries(p)) if (k.startsWith('cargo.')) add(k.slice('cargo.'.length), n);
	return out;
}

/**
 * The march a send made, from its payload and what the answer says of it (`armies.sent`: id, arrival) as the server
 * stores it: there and back in the same time, the upkeep of the whole trip paid up front (the units' upkeep in the static
 * `troops.units` x the seconds), sent at `now` (the clock the command ran at). Null: not a payload it can read.
 */
export function marchOf(
	payload: unknown,
	sent: ArmySent,
	at: { now: number; mission: string; fromName: UiText; catalog: UnitCatalog },
): ArmyMarch | null {
	const p = (payload ?? {}) as { x?: unknown; y?: unknown };
	const from = sentFrom(payload);
	const x = Number(p.x);
	const y = Number(p.y);
	if (!from || !Number.isInteger(x) || !Number.isInteger(y)) return null;
	const units = sentUnits(payload);
	const seconds = (sent.arrivesAt - at.now) / 1000;
	const provisions: Record<string, number> = {};
	for (const [u, n] of Object.entries(units))
		for (const [r, perSec] of Object.entries(at.catalog[u]?.upkeep ?? {}))
			provisions[r] = (provisions[r] ?? 0) + perSec * n * (2 * seconds);
	return {
		id: sent.id,
		from,
		target: { x, y },
		mission: at.mission,
		phase: 'outbound',
		units,
		loot: {},
		cargo: sentCargo(payload),
		provisions,
		report: null,
		departedAt: at.now,
		arrivesAt: sent.arrivesAt,
		returnsAt: sent.arrivesAt + seconds * 1000,
		fromName: at.fromName,
	};
}

/** The heroes put at the army's head (`heroes`, or the form's "hero1", "hero2"... selects). */
export function sentHeroes(payload: unknown): string[] {
	const p = (payload ?? {}) as Record<string, unknown>;
	const ids = Array.isArray(p.heroes)
		? p.heroes
		: Object.entries(p)
				.filter(([k, v]) => /^hero\d+$/.test(k) && v)
				.map(([, v]) => v);
	return [...new Set(ids.filter((x): x is string => typeof x === 'string' && !!x))];
}

/** The settlement a send payload leaves from. */
export const sentFrom = (payload: unknown): string | undefined => {
	const p = (payload ?? {}) as { from?: unknown; settlement?: unknown };
	const id = p.from ?? p.settlement;
	return typeof id === 'string' && id ? id : undefined;
};
