/**
 * The "trading blows" rule of realm adventures (docs/design/gameplay.md §9.4), shared by the
 * server (which decides) and the client (which previews). Closed form, no round-by-round loop.
 */

/**
 * A hero's adventure numbers. `recovery`: % of the hero's max hp regained between groups;
 * `luck`: % more weight for each extra drop of a beaten group (0 for older numbers).
 */
export interface AdventureStats {
	attack: number;
	defense: number;
	hp: number;
	recovery: number;
	luck?: number;
}

export interface MonsterGroup {
	/** Text to translate. */
	name: string;
	attack: number;
	defense: number;
	hp: number;
	boss?: boolean;
}

export interface GroupOutcome {
	/** Hero hp when the fight starts and when it ends (before recovering for the next group). */
	hpBefore: number;
	hpAfter: number;
	won: boolean;
	rounds: number;
}

/**
 * Fight the groups in order until the hero falls. Each round the hero strikes first:
 * damage = max(attack - defence, attack x minDamage) on both sides.
 */
export function fightGroups(hero: AdventureStats, groups: MonsterGroup[], minDamage = 0.1): GroupOutcome[] {
	const out: GroupOutcome[] = [];
	let hp = hero.hp;
	for (const g of groups) {
		const dealt = Math.max(hero.attack - g.defense, hero.attack * minDamage);
		const taken = Math.max(g.attack - hero.defense, g.attack * minDamage);
		const toKill = dealt > 0 ? Math.ceil(g.hp / dealt) : Infinity;
		const toFall = taken > 0 ? Math.ceil(hp / taken) : Infinity;
		// The hero strikes first, so it wins when it needs no more rounds than the monsters need to fell it.
		const won = toKill <= toFall;
		const rounds = won ? toKill : toFall;
		const after = won ? hp - (toKill - 1) * taken : 0;
		out.push({ hpBefore: hp, hpAfter: Math.max(0, after), won, rounds });
		if (!won) break;
		hp = Math.min(hero.hp, after + (hero.hp * hero.recovery) / 100);
	}
	return out;
}
