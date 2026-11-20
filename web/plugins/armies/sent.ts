// What sending troops did (every command that sends an army: attack, transfer, transport, gathering, founding,
// uprooting), applied to the player's data held in the browser (user 2026-11-20: "你告诉前端成功了，前端不就能更新了吗？"):
// the troops are gone from their garrison on every page, the heroes leading them on duty. Pure: the tests run them.

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
