/**
 * The "trading blows" rule of realm adventures (docs/design/gameplay.md §9.4), shared by the
 * server (which decides) and the client (which previews). Closed form, no round-by-round loop.
 */
import type { RealmsInfo, RealmsOverview, RealmsStatic } from './api';
import type { ClientViewGet } from './client-views';
import { heroAttributes } from './heroes';

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

/** Adventure numbers as a table of the attributes: { stat: { base, <attribute>: factor } } (starter-realms' rule). */
export type HeroStatsTable = Record<string, Record<string, number>>;

/** The numbers a table gives a hero with these attributes (with every bonus). */
export function statsFromTable(table: HeroStatsTable, attrs: Record<string, number>): Record<string, number> {
	const out: Record<string, number> = {};
	for (const [stat, row] of Object.entries(table))
		out[stat] = Object.entries(row).reduce((sum, [k, f]) => sum + (k === 'base' ? f : (attrs[k] ?? 0) * f), 0);
	return out;
}

/** A hero's adventure numbers from every source's share, kept in range (`realms.heroStats`, and the cards). */
export function adventureTotal(parts: readonly Partial<AdventureStats>[]): Required<AdventureStats> {
	const out: Required<AdventureStats> = { attack: 0, defense: 0, hp: 0, recovery: 0, luck: 0 };
	for (const p of parts) for (const [k, v] of Object.entries(p)) if (k in out) out[k as keyof AdventureStats] += v ?? 0;
	return {
		attack: Math.max(0, out.attack),
		defense: Math.max(0, out.defense),
		hp: Math.max(1, out.hp),
		recovery: Math.max(0, out.recovery),
		luck: Math.max(0, out.luck),
	};
}

/**
 * What the realms plugin attaches to a hero's card (`heroes.addCardData`): recovery from research (`realms.recovery`),
 * which the browser cannot work out. The client part adds the shares at "realms.heroStats" and keeps the total in range.
 */
export interface AdventureCardData {
	recovery: number;
}

/** Client extension point "realms.heroStats": a client plugin's share of a hero's adventure numbers. */
export type HeroStatsPart = (hero: { id: string; attrs: Record<string, number> }, get: ClientViewGet) => Partial<AdventureStats>;

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
	// By the task's groups (the static view's array: the same while the rules stay) and the hero's numbers: the Realms
	// page asks it for every task of every open realm on each sync, and the assistant again (some forty fights each).
	const key = `${hero.attack}|${hero.defense}|${hero.hp}|${hero.recovery}|${minDamage}`;
	let byHero = margins.get(groups);
	if (!byHero) margins.set(groups, (byHero = new Map()));
	let m = byHero.get(key);
	if (m === undefined) {
		if (byHero.size > 64) byHero.clear(); // heroes level up: old numbers are not asked again
		byHero.set(key, (m = marginOf(hero, groups, minDamage)));
	}
	return m;
}
const margins = new WeakMap<MonsterGroup[], Map<string, number>>();
function marginOf(hero: AdventureStats, groups: MonsterGroup[], minDamage: number): number {
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

/**
 * A hero's adventure numbers in the browser: the shares the client parts at "realms.heroStats" give (attributes, gear;
 * the hero's attributes with what the parts at "heroes.attributes" add) and recovery from research, in range.
 */
export function adventureOf(
	hero: { id: string; attrs: Record<string, number> },
	recovery: number,
	get: ClientViewGet,
): Required<AdventureStats> {
	const full = { id: hero.id, attrs: heroAttributes(hero, get) };
	return adventureTotal([...[...get.parts<HeroStatsPart>('realms.heroStats').values()].map((share) => share(full, get)), { recovery }]);
}

/** The extension points `adventureOf` runs (a client view using it declares them: what their parts need is fetched). */
export const ADVENTURE_POINTS = ['realms.heroStats', 'heroes.attributes'];

/** Every hero's adventure numbers from the overview (`adventureOf`), by hero id, rounded for the eye. */
export function heroStatsOf(overview: RealmsOverview | null | undefined, get: ClientViewGet): Record<string, AdventureStats> {
	const out: Record<string, AdventureStats> = {};
	const r = (v: number) => Math.round(v * 100) / 100;
	for (const h of overview?.heroes ?? []) {
		const s = adventureOf(h, overview!.recovery, get);
		out[h.id] = { attack: r(s.attack), defense: r(s.defense), hp: r(s.hp), recovery: r(s.recovery), luck: r(s.luck) };
	}
	return out;
}

/**
 * `realmsInfo` with the heroes' numbers worked out in the browser (`heroStatsOf`), kept by the overview, the static
 * view and those numbers: the Realms page's views, the realm shop and the assistant ask with the same after a sync.
 */
export function realmsInfoOf(overview: RealmsOverview | null | undefined, statics: RealmsStatic | null | undefined, get: ClientViewGet) {
	if (!overview || !statics) return null;
	const heroStats = heroStatsOf(overview, get);
	const key = JSON.stringify(heroStats);
	const kept = infos.get(overview);
	if (kept && kept.statics === statics && kept.key === key) return kept.info;
	const info = realmsInfo(overview, statics, heroStats);
	infos.set(overview, { statics, key, info });
	return info;
}
const infos = new WeakMap<RealmsOverview, { statics: RealmsStatic; key: string; info: RealmsInfo | null }>();

/**
 * The player's realms as a whole: the overview (which realms are open, which tasks cleared, adventures, injuries) put
 * together with the static `realms.tasks` (realms, tasks, monsters, drops and rule numbers, the same for everyone) and
 * the heroes' numbers (`heroStatsOf`). The drop lists only of tasks the player cleared. Null until both are there.
 */
export function realmsInfo(
	overview: RealmsOverview | null | undefined,
	statics: RealmsStatic | null | undefined,
	heroStats: Record<string, AdventureStats>,
): RealmsInfo | null {
	if (!overview || !statics) return null;
	const { unlocked, cleared, ...own } = overview;
	const { realms, ...rules } = statics;
	const open = new Set(unlocked);
	return {
		...own,
		...rules,
		heroStats,
		realms: realms.map((r) => {
			const done = new Set(cleared[r.id] ?? []);
			return {
				...r,
				unlocked: open.has(r.id),
				tasks: r.tasks.map(({ drops, ...t }, index) => ({ ...t, index, cleared: done.has(index), ...(done.has(index) ? { drops } : {}) })),
			};
		}),
	};
}
