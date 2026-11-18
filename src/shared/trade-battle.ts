/**
 * The trade routes' fights (docs/design/gameplay.md §17.2; user 2026-11-16: "宽度为2或3的战斗，敌人也有对应路数的兵团，每回合
 * 我方兵团轮流随机砍一个敌方兵团，我方砍完后敌方兵团轮流随机砍一个我方兵团。敌方可以有一组，死光了的往前递补。"): columns
 * trading blows round by round, every strike written down for the browser to play. The server works it out once, with
 * a random seed (user: "那就不直接判负了，万一有奇迹呢"), and its log is what happened. Pure.
 */

export interface TradeColumnStats {
	id: string;
	family?: string;
	attack: number;
	defense: number;
	hp: number;
	/**
	 * Its attack when it counters the column it strikes, its defence when it counters the one striking it: the battle's
	 * counter (the troops' part x `battle.counterFactor`, 3; user 2026-11-18: "是不是又各写一套了？"). None: as without.
	 */
	counterAttack?: number;
	counterDefense?: number;
	/**
	 * Chance (0-1) that it strikes a column it counters when one stands in front (user 2026-11-18: "优先砍克制的，但如果
	 * 英雄属性太低，则又有概率瞎砍"); otherwise, or with none there, any column at random. None: always at random.
	 */
	aim?: number;
}

export interface TradeStrike {
	round: number;
	side: 'ours' | 'theirs';
	from: string;
	to: string;
	damage: number;
	miss?: true;
	/** The target fell; the next of its side in reserve (if any) took its place. */
	fell?: true;
	/** Who took its place. */
	next?: string;
}

/** How fights go (rule `trade-routes.battle`). */
export interface TradeBattleRules {
	/**
	 * Each strike deals pace x attack² / (attack + defence) (attack as the column's hp left says), give or take the
	 * spread: fights of several rounds.
	 */
	pace: number;
	/** Chance (0-1) a strike misses. */
	miss: number;
	/** Rounds at most: then the attackers give up (lost). */
	maxRounds: number;
	/** Each strike's damage varies by up to this share either way (user 2026-11-18: "伤害浮动加一点"); none if left out. */
	spread?: number;
}

export interface TradeBattleLog {
	width: number;
	ours: TradeColumnStats[];
	/** Front first: the first `width` fight at once, the others wait to step up. */
	theirs: TradeColumnStats[];
	strikes: TradeStrike[];
	won: boolean;
	/** Hp left by column id (both sides). */
	left: Record<string, number>;
}

export function fightColumns(
	ours: readonly TradeColumnStats[],
	theirs: readonly TradeColumnStats[],
	width: number,
	rules: TradeBattleRules,
	random: () => number,
	counters: (strong: string, weak: string) => boolean = () => false,
): TradeBattleLog {
	const hp: Record<string, number> = {};
	for (const c of [...ours, ...theirs]) hp[c.id] = c.hp;
	const maxHp = new Map([...ours, ...theirs].map((c) => [c.id, c.hp]));
	const byId = new Map([...ours, ...theirs].map((c) => [c.id, c]));
	const front = theirs.slice(0, width).map((c) => c.id);
	const reserve = theirs.slice(width).map((c) => c.id);
	const strikes: TradeStrike[] = [];
	const alive = (id: string) => hp[id] > 0;
	const pick = (list: string[]) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
	/** Its target: one it counters if it sees the chance (its aim), else any. */
	const choose = (from: string, targets: string[]) => {
		const a = byId.get(from)!;
		if (a.aim && a.family) {
			const weak = targets.filter((t) => {
				const f = byId.get(t)!.family;
				return !!f && counters(a.family!, f);
			});
			if (weak.length && weak.length < targets.length && random() < a.aim) return pick(weak);
		}
		return pick(targets);
	};
	const strike = (round: number, side: 'ours' | 'theirs', from: string, to: string) => {
		const a = byId.get(from)!;
		const d = byId.get(to)!;
		const strong = !!a.family && !!d.family && counters(a.family, d.family);
		const shielded = !!a.family && !!d.family && counters(d.family, a.family);
		const attack = (strong ? (a.counterAttack ?? a.attack) : a.attack) * (hp[from] / (maxHp.get(from) || 1));
		const defense = shielded ? (d.counterDefense ?? d.defense) : d.defense;
		const miss = random() < rules.miss;
		const spread = !miss && rules.spread ? 1 + rules.spread * (2 * random() - 1) : 1;
		const damage = miss ? 0 : Math.max(0, (spread * rules.pace * attack * attack) / (attack + defense || 1));
		hp[to] = Math.max(0, hp[to] - damage);
		const s: TradeStrike = { round, side, from, to, damage: Math.round(damage * 100) / 100, ...(miss ? { miss: true as const } : {}) };
		if (!hp[to]) {
			s.fell = true;
			if (side === 'ours') {
				const at = front.indexOf(to);
				const next = reserve.shift();
				if (next) {
					front[at] = next;
					s.next = next;
				} else front.splice(at, 1);
			}
		}
		strikes.push(s);
	};
	let won = false;
	for (let round = 1; round <= rules.maxRounds; round++) {
		for (const id of ours.map((c) => c.id)) {
			if (!alive(id)) continue;
			const targets = front.filter(alive);
			if (!targets.length) break;
			strike(round, 'ours', id, choose(id, targets));
		}
		if (!front.some(alive) && !reserve.length) {
			won = true;
			break;
		}
		for (const id of [...front]) {
			if (!alive(id)) continue;
			const targets = ours.map((c) => c.id).filter(alive);
			if (!targets.length) break;
			strike(round, 'theirs', id, choose(id, targets));
		}
		if (!ours.some((c) => alive(c.id))) break;
	}
	return { width, ours: [...ours], theirs: [...theirs], strikes, won, left: hp };
}
