// The equipment steward (user 2026-11-08: "小助手新增'装备'功能"): each group of heroes (a settlement's, or a group the
// player made in it) shares out its pieces in its order, "first come, first served" ("捡旧顺序"): the first hero picks
// from the settlement's storage and what the others of the group wear, then the next from what is left. A hero puts a
// piece on when it raises what the player wants of that hero more than what it wears in that slot does. Pure: the
// tests run it.
import { type HeroStatsTable, statsFromTable } from '../../../src/shared/realms';
import { type HeroEffectsStatic, rowPercent } from '../../../src/shared/starter-heroes';

/**
 * What a hero is worked out for, each a number of its own (user: "不能笼统地选'冒险'，而是'冒险-攻击'这种"):
 * "attr:<attribute>", "adv:<attack|defense|hp|recovery|luck>" (adventure), "flat:<attack|defense|hp>" (each lane when
 * leading or defending, the pieces' own), "pct:<attack|defense|hp>" (the % its attributes give when leading),
 * "gov:<production|construction|training|upkeep>" (as a governor), "sch:<research|researchCost>" (at an institute).
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
	/** Duties' % from attributes (static `starter-heroes.effects`). */
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
	const out: Record<string, number> = {};
	let adventure: Record<string, number> | undefined;
	for (const { target } of wants) {
		const [kind, what] = target.split(':');
		if (kind === 'attr') out[target] = attrs[what] ?? 0;
		else if (kind === 'adv') {
			adventure ??= (() => {
				const own = tables.adventure ? statsFromTable(tables.adventure, attrs) : {};
				const worn = sum('adv.');
				return Object.fromEntries(
					[...new Set([...Object.keys(own), ...Object.keys(worn)])].map((k) => [k, (own[k] ?? 0) + (worn[k] ?? 0)]),
				);
			})();
			out[target] = adventure[what] ?? 0;
		} else if (kind === 'flat') out[target] = sum('battle.')[what] ?? 0;
		else if (DUTY[kind] && tables.effects)
			out[target] = tables.effects.rows
				.filter((r) => r.duty === DUTY[kind] && r.effect === what)
				.reduce((n, r) => n + rowPercent(r, tables.effects!.rules, { attrs, level: hero.level }), 0);
	}
	return out;
}

/** How much better `next` is than `now`: each want's change relative to where it stands (user: "没填的默认比较当前百分比"), x its weight. */
export function gain(now: Record<string, number>, next: Record<string, number>, wants: readonly Want[]): number {
	return wants.reduce((n, w) => {
		const a = now[w.target] ?? 0;
		const b = next[w.target] ?? 0;
		return n + (w.weight ?? 1) * ((b - a) / Math.max(Math.abs(a), 1));
	}, 0);
}

/**
 * The group's plan: in its heroes' order, each takes for each slot the piece (from storage, from those after it in the
 * group, or what it wears) that raises its wants most; those before it keep theirs. Returns the moves (a piece onto a
 * hero), in order. Heroes with no wants keep what they wear unless one before them takes it.
 */
export function outfit(
	heroes: readonly OutfitHero[],
	pieces: readonly OutfitPiece[],
	wantsOf: (hero: string) => readonly Want[],
	tables: OutfitTables,
): { piece: string; hero: string }[] {
	const wearing = new Map(heroes.map((h) => [h.id, new Map(pieces.filter((p) => p.hero === h.id).map((p) => [p.slot, p]))]));
	const taken = new Set<string>();
	const moves: { piece: string; hero: string }[] = [];
	const slots = [...new Set(pieces.map((p) => p.slot))];
	for (const hero of heroes) {
		const wants = wantsOf(hero.id);
		const own = wearing.get(hero.id)!;
		if (wants.length)
			for (let pass = 0; pass < 2; pass++)
				for (const slot of slots) {
					const now = [...own.values()];
					const cur = own.get(slot);
					const base = numbersWith(hero, now, tables, wants);
					let best: OutfitPiece | undefined;
					let bestGain = 1e-9;
					for (const p of pieces) {
						if (p.slot !== slot || p === cur || taken.has(p.id) || p.minLevel > hero.level) continue;
						if (p.group) {
							// One of each kind, up to its limit: a new kind only while there is room.
							const worn = now.filter((x) => x.group === p.group).length;
							if (!cur && worn >= hero.accessories) continue;
						}
						const next = numbersWith(hero, [...now.filter((x) => x !== cur), p], tables, wants);
						const g = gain(base, next, wants);
						if (g > bestGain) ((best = p), (bestGain = g));
					}
					if (!best) continue;
					// Off whoever after it wore it (they pick later from what is left).
					for (const [, theirs] of wearing) if (theirs.get(best.slot) === best) theirs.delete(best.slot);
					own.set(slot, best);
				}
		for (const p of own.values()) {
			taken.add(p.id);
			if (p.hero !== hero.id) moves.push({ piece: p.id, hero: hero.id });
		}
	}
	return moves;
}
