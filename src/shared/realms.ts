/**
 * The "trading blows" rule of realm adventures (docs/design/gameplay.md §9.4), shared by the
 * server (which decides) and the client (which previews). Closed form, no round-by-round loop.
 */

/**
 * A hero's adventure numbers. `recovery`: % of the hero's max hp regained between groups;
 * `luck`: % more drawn from the reward pool for each beaten group (0 for older numbers).
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

/** Strikes may miss: each one, the hero's and the monsters', misses with chance `miss` (0-1). */
export interface FightChance {
	miss: number;
	random: () => number;
}

/**
 * Fight the groups in order until the hero falls. Each round the hero strikes first:
 * damage = max(attack - defence, attack x minDamage) on both sides. Without `chance` every strike
 * lands (a closed form); with it each may miss, so the same fight can go either way.
 */
export function fightGroups(hero: AdventureStats, groups: MonsterGroup[], minDamage = 0.1, chance?: FightChance): GroupOutcome[] {
	const out: GroupOutcome[] = [];
	let hp = hero.hp;
	for (const g of groups) {
		const dealt = Math.max(hero.attack - g.defense, hero.attack * minDamage);
		const taken = Math.max(g.attack - hero.defense, g.attack * minDamage);
		let won: boolean;
		let rounds: number;
		let after: number;
		if (chance && chance.miss > 0) {
			// A few rounds a group: play them out (at most MAX_ROUNDS, then the hero is worn down).
			let monster = g.hp;
			let left = hp;
			rounds = 0;
			while (monster > 0 && left > 0 && rounds < MAX_ROUNDS) {
				rounds++;
				if (chance.random() >= chance.miss) monster -= dealt;
				if (monster > 0 && chance.random() >= chance.miss) left -= taken;
			}
			won = monster <= 0;
			after = won ? left : 0;
		} else {
			const toKill = dealt > 0 ? Math.ceil(g.hp / dealt) : Infinity;
			const toFall = taken > 0 ? Math.ceil(hp / taken) : Infinity;
			// The hero strikes first, so it wins when it needs no more rounds than the monsters need to fell it.
			won = toKill <= toFall;
			rounds = won ? toKill : toFall;
			after = won ? hp - (toKill - 1) * taken : 0;
		}
		out.push({ hpBefore: hp, hpAfter: Math.max(0, after), won, rounds });
		if (!won) break;
		hp = Math.min(hero.hp, after + (hero.hp * hero.recovery) / 100);
	}
	return out;
}
const MAX_ROUNDS = 1000;

/**
 * How the hero measures up to a task: the strongest the monsters could all be (as a factor on their
 * attack, defence and hp) for the hero to still clear it with every strike landing. Above 1: the hero
 * has room to spare; below 1: it falls short (and needs luck).
 */
export function margin(hero: AdventureStats, groups: MonsterGroup[], minDamage = 0.1): number {
	const clears = (k: number) => {
		const out = fightGroups(
			hero,
			groups.map((g) => ({ ...g, attack: g.attack * k, defense: g.defense * k, hp: g.hp * k })),
			minDamage,
		);
		return out.length === groups.length && out.every((o) => o.won);
	};
	let lo = 0.01;
	let hi = 100;
	if (!clears(lo)) return 0;
	if (clears(hi)) return hi;
	for (let i = 0; i < 40; i++) {
		const mid = Math.sqrt(lo * hi);
		if (clears(mid)) lo = mid;
		else hi = mid;
	}
	return lo;
}
