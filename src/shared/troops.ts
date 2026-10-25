/**
 * A body of troops' totals from each unit's numbers (the rules' `troops.units`, no bonuses): attack, defence and hp
 * summed, the slowest speed. The server's `troops.totals` (carry for loot, a garrison's strength) and the Army page's
 * strength line (from the static view in the browser) go by it. Pure.
 */
import type { UnitNumbers } from './api';

export function unitTotals(
	units: Record<string, number>,
	numbersOf: (unit: string) => Pick<UnitNumbers, 'attack' | 'defense' | 'hp' | 'carry' | 'speed'> | undefined,
) {
	const out = { attack: 0, defense: 0, hp: 0, carry: 0, speed: 0 };
	let slowest = Infinity;
	for (const [unit, n] of Object.entries(units)) {
		const u = n ? numbersOf(unit) : undefined;
		if (!u) continue;
		out.attack += u.attack * n;
		out.defense += u.defense * n;
		out.hp += u.hp * n;
		out.carry += u.carry * n;
		slowest = Math.min(slowest, u.speed);
	}
	out.speed = Number.isFinite(slowest) ? slowest : 0;
	return out;
}
