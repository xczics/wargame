// The equipment steward (user 2026-11-08: "小助手新增'装备'功能"): each group of heroes (a settlement's, or a group the
// player made in it) shares out its pieces in its order, "first come, first served" ("捡旧顺序"): the first hero picks
// from the settlement's storage and what the others of the group wear, then the next from what is left. Pure: the
// tests run it.
//
// Worked out whole first, then made in as few steps as it takes, in an order the storage allows (user 2026-11-08:
// "装备统筹计算先缓存、再规划最小换衣服方案，最后一起换"), with the commands a player has (equip, unequip): nothing of the
// server's for the assistant (user: "小助手永远只是模拟玩家操作").
import { type HeroStatsTable, statsFromTable } from '../../../src/shared/realms';
import { flatOf, type HeroEffectsStatic, rowPercent } from '../../../src/shared/starter-heroes';

/**
 * What a hero is worked out for, each a number of its own (user: "不能笼统地选'冒险'，而是'冒险-攻击'这种"):
 * "attr:<attribute>", "adv:<attack|defense|hp|recovery|luck>" (adventure), "flat:<attack|defense|hp>" (each lane when
 * leading or defending: the pieces' own and what the hero's attributes give), "pct:<attack|defense|hp>" (the % its
 * attributes give when leading), "gov:<production|construction|training|upkeep>" (as a governor),
 * "sch:<research|researchCost>" (at an institute).
 */
export interface Want {
	target: string;
	/** How much it counts (none: 1). */
	weight?: number;
}

export interface OutfitHero {
	id: string;
	level: number;
	gender: 'm' | 'f';
	/** Its own attributes (without what it wears). */
	attrs: Record<string, number>;
	/** How many accessories it may wear. */
	accessories: number;
}

export interface OutfitPiece {
	id: string;
	slot: string;
	/** The slot's group (e.g. accessories: up to the hero's limit, one of each kind). */
	group?: string;
	minLevel: number;
	stats: Record<string, number>;
	/** Who wears it (null: in the settlement's storage). */
	hero: string | null;
}

export interface OutfitTables {
	/** Adventure numbers from attributes (static `starter-realms.heroStats`). */
	adventure?: HeroStatsTable;
	/** Duties' % and flat lane numbers from attributes (static `starter-heroes.effects`). */
	effects?: HeroEffectsStatic;
}

const DUTY: Record<string, string> = { pct: 'command', gov: 'governor', sch: 'scholar' };

/** A hero's numbers for its wants with these pieces on. */
export function numbersWith(
	hero: OutfitHero,
	pieces: readonly OutfitPiece[],
	tables: OutfitTables,
	wants: readonly Want[],
): Record<string, number> {
	const sum = (prefix: string) => {
		const out: Record<string, number> = {};
		for (const p of pieces)
			for (const [k, v] of Object.entries(p.stats))
				if (k.startsWith(prefix)) out[k.slice(prefix.length)] = (out[k.slice(prefix.length)] ?? 0) + v;
		return out;
	};
	const attrs = { ...hero.attrs };
	for (const [a, v] of Object.entries(sum('attr.'))) attrs[a] = (attrs[a] ?? 0) + v;
	const me = { attrs, level: hero.level };
	const out: Record<string, number> = {};
	for (const { target } of wants) {
		const [kind, what] = target.split(':');
		if (kind === 'attr') out[target] = attrs[what] ?? 0;
		else if (kind === 'adv')
			out[target] = (tables.adventure ? (statsFromTable(tables.adventure, attrs)[what] ?? 0) : 0) + (sum('adv.')[what] ?? 0);
		else if (kind === 'flat') {
			const own = tables.effects?.flat ? (flatOf(tables.effects.flat, tables.effects.rules, 'command', [me])[what] ?? 0) : 0;
			out[target] = own + (sum('battle.')[what] ?? 0);
		} else if (DUTY[kind] && tables.effects)
			out[target] = tables.effects.rows
				.filter((r) => r.duty === DUTY[kind] && r.effect === what)
				.reduce((n, r) => n + rowPercent(r, tables.effects!.rules, me), 0);
	}
	return out;
}

/**
 * What one point of the attribute that serves a number best gives of it at this level (user 2026-11-08: "你要根据对游戏的
 * 理解，设置参考值。让各属性的比例尽可能均一。"): every number counted in "attribute points", so a weight of 1 means the
 * same for each. From the baked tables (what the GM sets); 1 where they say nothing.
 */
export function referenceOf(target: string, level: number, tables: OutfitTables): number {
	const [kind, what] = target.split(':');
	let best = 0;
	if (kind === 'attr') return 1;
	if (kind === 'adv' && tables.adventure?.[what])
		for (const [k, f] of Object.entries(tables.adventure[what])) if (k !== 'base') best = Math.max(best, f);
	if (kind === 'flat' && tables.effects?.flat)
		for (const f of tables.effects.flat)
			if (f.duty === 'command' && f.stat === what) best = Math.max(best, f.perPoint * level ** tables.effects.rules.flatLevelPower);
	if (DUTY[kind] && tables.effects)
		for (const r of tables.effects.rows)
			if (r.duty === DUTY[kind] && r.effect === what)
				best = Math.max(best, rowPercent(r, tables.effects.rules, { attrs: { [r.attribute]: 1 }, level }));
	return best > 0 ? best : 1;
}

/**
 * How much a piece is worth to a hero: each want's growth in attribute points, x its weight. The numbers are linear in
 * what is worn, so a piece's worth does not hang on the others: the best of each slot is the best outfit.
 */
export function worth(hero: OutfitHero, piece: OutfitPiece, tables: OutfitTables, wants: readonly Want[]): number {
	const bare = numbersWith(hero, [], tables, wants);
	const on = numbersWith(hero, [piece], tables, wants);
	return wants.reduce(
		(n, w) => n + ((w.weight ?? 1) * ((on[w.target] ?? 0) - (bare[w.target] ?? 0))) / referenceOf(w.target, hero.level, tables),
		0,
	);
}

/**
 * Who wears what in the end (by piece; null: in storage), for the pieces of the group and its settlement's storage: in
 * the heroes' order, each takes for every slot the best piece left (from storage, from those after it, or its own; its
 * own when as good), and of each accessory group the best kind's best piece, the best kinds up to its limit. Those
 * with no wants keep what is left of theirs.
 */
export function plan(
	heroes: readonly OutfitHero[],
	pieces: readonly OutfitPiece[],
	wantsOf: (hero: string) => readonly Want[],
	tables: OutfitTables,
): Map<string, string | null> {
	const owner = new Map(pieces.map((p) => [p.id, p.hero]));
	const locked = new Set<string>();
	for (const hero of heroes) {
		const wants = wantsOf(hero.id);
		const mine = (p: OutfitPiece) => owner.get(p.id) === hero.id;
		const free = (p: OutfitPiece) => !locked.has(p.id) && p.minLevel <= hero.level;
		if (!wants.length) {
			for (const p of pieces) if (mine(p)) locked.add(p.id);
			continue;
		}
		const value = new Map(pieces.filter(free).map((p) => [p.id, worth(hero, p, tables, wants)]));
		// The best of a slot: the most worth, its own first when as good (no step for nothing).
		const bestOf = (slot: string) =>
			pieces
				.filter((p) => p.slot === slot && free(p))
				.sort((a, b) => value.get(b.id)! - value.get(a.id)! || Number(mine(b)) - Number(mine(a)))[0];
		const take = (p: OutfitPiece) => {
			owner.set(p.id, hero.id);
			locked.add(p.id);
		};
		const drop = (p: OutfitPiece) => owner.set(p.id, null);
		const slots = [...new Set(pieces.map((p) => p.slot))];
		for (const slot of slots.filter((s) => !pieces.find((p) => p.slot === s)!.group)) {
			const best = bestOf(slot);
			const own = pieces.find((p) => p.slot === slot && mine(p));
			if (!best || (value.get(best.id)! <= 0 && !own)) continue;
			if (own && own !== best) drop(own);
			take(best);
		}
		for (const group of new Set(pieces.flatMap((p) => (p.group ? [p.group] : [])))) {
			const kinds = slots.filter((s) => pieces.find((p) => p.slot === s)!.group === group);
			const chosen = kinds
				.map((s) => bestOf(s))
				.filter((p): p is OutfitPiece => !!p && value.get(p.id)! > 0)
				.sort((a, b) => value.get(b.id)! - value.get(a.id)! || Number(mine(b)) - Number(mine(a)))
				.slice(0, Math.max(0, hero.accessories));
			for (const p of pieces) if (p.group === group && mine(p) && !chosen.includes(p)) drop(p);
			for (const p of chosen) take(p);
		}
		// Whatever was taken from those after it is theirs no more (dropped above when the hero gave its own up).
	}
	return owner;
}

/** A step a player could make: a piece onto a hero (what it wore there goes to storage), or into storage (null). */
export interface OutfitStep {
	piece: string;
	hero: string | null;
}

/**
 * The steps from what is worn now to `final`, as few as it takes (a piece pushed off by another needs no step of its
 * own), in an order the storage and the accessory limits allow at every step, as the server checks them: a piece from
 * storage first, then swaps that keep the storage as it is, then those that fill it. What no order allows is left out
 * (`skipped`).
 */
export function steps(
	heroes: readonly OutfitHero[],
	pieces: readonly OutfitPiece[],
	final: ReadonlyMap<string, string | null>,
	o: { stored: number; capacity: number },
): { steps: OutfitStep[]; skipped: string[] } {
	const byId = new Map(pieces.map((p) => [p.id, p]));
	const limit = new Map(heroes.map((h) => [h.id, h.accessories]));
	const owner = new Map(pieces.map((p) => [p.id, p.hero]));
	let stored = o.stored;
	const out: OutfitStep[] = [];
	const wornAt = (hero: string, slot: string) => pieces.find((p) => owner.get(p.id) === hero && p.slot === slot);
	const pending = () => pieces.filter((p) => final.has(p.id) && owner.get(p.id) !== final.get(p.id));
	for (let guard = 0; guard < pieces.length * 4; guard++) {
		const left = pending();
		if (!left.length) break;
		const options: { step: OutfitStep; delta: number; order: number }[] = [];
		for (const p of left) {
			const to = final.get(p.id)!;
			if (to === null) {
				// Into storage: only when nothing will take its place (that pushes it off for free).
				const at = owner.get(p.id)!;
				if (left.some((q) => final.get(q.id) === at && q.slot === p.slot)) continue;
				if (stored + 1 <= o.capacity) options.push({ step: { piece: p.id, hero: null }, delta: 1, order: options.length });
				continue;
			}
			const old = wornAt(to, p.slot);
			if (p.group && !old && pieces.filter((x) => owner.get(x.id) === to && x.group === p.group).length >= (limit.get(to) ?? 0)) continue;
			const delta = (owner.get(p.id) === null ? -1 : 0) + (old ? 1 : 0);
			if (delta > 0 && stored + delta > o.capacity) continue;
			options.push({ step: { piece: p.id, hero: to }, delta, order: options.length });
		}
		const next = options.sort((a, b) => a.delta - b.delta || a.order - b.order)[0];
		if (!next) break;
		const p = byId.get(next.step.piece)!;
		if (next.step.hero) {
			const old = wornAt(next.step.hero, p.slot);
			if (old) owner.set(old.id, null);
		}
		owner.set(p.id, next.step.hero);
		stored += next.delta;
		out.push(next.step);
	}
	return { steps: out, skipped: pending().map((p) => p.id) };
}

/** The group's plan and its steps (`plan`, then `steps`). */
export function outfit(
	heroes: readonly OutfitHero[],
	pieces: readonly OutfitPiece[],
	wantsOf: (hero: string) => readonly Want[],
	tables: OutfitTables,
	room: { stored: number; capacity: number } = { stored: 0, capacity: Infinity },
): { steps: OutfitStep[]; skipped: string[] } {
	return steps(heroes, pieces, plan(heroes, pieces, wantsOf, tables), room);
}
