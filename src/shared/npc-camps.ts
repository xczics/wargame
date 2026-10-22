/**
 * (Shared: the server decides with it, the browser draws the map with it from the same rules, user 2026-10-22: "规则生成
 * 的甚至连列表都不用转".)
 *
 * Where the world's NPC camps stand, worked out from the rules instead of stored (1.4; user 2026-10-18: "营寨走规则计算"):
 * the map is cut into blocks of `blockSize` tiles a side; each block holds `perBlock` camps give or take `spread`, on
 * tiles, of kinds (`fortressShare`) and levels (the spawn weights) all drawn from a seed of the world and the block.
 * The same rules always give the same camps, so nothing about an untouched camp is stored; what happened to one (a
 * raid, uprooting) is kept apart (`npc_camps_state`), and whether it stands is decided by the plugin (index.ts).
 */
import { seededRandom } from './random';

export interface LayoutRules {
	seed: number;
	blockSize: number;
	perBlock: number;
	spread: number;
	fortressShare: number;
	/** Weight of each level, "1" to "10". */
	weights: Record<string, number>;
}

export interface RuleCamp {
	/** "npc:<bx>,<by>,<slot>": stable while the rules are the same. */
	id: string;
	x: number;
	y: number;
	kind: 'npc-fortress' | 'npc-outpost';
	level: number;
}

const PREFIX = 'npc:';
export const isRuleCamp = (id: string) => id.startsWith(PREFIX);

/** The camps of the rules, block by block, worked out once per isolate and set of rules. */
export class Layout {
	readonly size: number;
	readonly blocks: number;
	private readonly cache = new Map<number, { camps: RuleCamp[]; byTile: Map<string, RuleCamp> }>();
	constructor(
		readonly rules: LayoutRules,
		/** Tiles a side of the map, and how a coordinate wraps onto it (0 .. mapSize - 1 to map coordinates). */
		readonly mapSize: number,
		private readonly wrap: (v: number) => number,
	) {
		this.size = Math.max(1, Math.floor(rules.blockSize));
		this.blocks = Math.ceil(mapSize / this.size);
	}

	/** 0 .. mapSize - 1 along an axis. */
	private unwrap(v: number) {
		return ((v % this.mapSize) + this.mapSize) % this.mapSize;
	}
	private coord(u: number) {
		return this.wrap(u);
	}

	block(bx: number, by: number) {
		const key = by * this.blocks + bx;
		let b = this.cache.get(key);
		if (!b) this.cache.set(key, (b = this.work(bx, by)));
		return b;
	}

	private work(bx: number, by: number) {
		const r = this.rules;
		const random = seededRandom(`npc-camps:layout:${r.seed}:${bx},${by}`);
		const spread = Math.max(0, Math.round(r.spread));
		const count = Math.max(0, Math.round(r.perBlock) + Math.floor(random() * (2 * spread + 1)) - spread);
		// The block's own tiles (the last block of a row may be cut short by the map's edge).
		const w = Math.min(this.size, this.mapSize - bx * this.size);
		const h = Math.min(this.size, this.mapSize - by * this.size);
		const cells = w * h;
		const taken = new Set<number>();
		const camps: RuleCamp[] = [];
		const weights = Object.entries(r.weights).map(([lv, wt]) => [Number(lv), Math.max(0, wt)] as const);
		const total = weights.reduce((a, [, wt]) => a + wt, 0);
		for (let slot = 0; slot < Math.min(count, cells); slot++) {
			let cell = Math.floor(random() * cells);
			while (taken.has(cell)) cell = (cell + 1) % cells;
			taken.add(cell);
			const kind = random() < r.fortressShare ? 'npc-fortress' : 'npc-outpost';
			let at = random() * total;
			let level = 1;
			for (const [lv, wt] of weights)
				if ((at -= wt) < 0) {
					level = lv;
					break;
				}
			camps.push({
				id: `${PREFIX}${bx},${by},${slot}`,
				x: this.coord(bx * this.size + (cell % w)),
				y: this.coord(by * this.size + Math.floor(cell / w)),
				kind,
				level,
			});
		}
		return { camps, byTile: new Map(camps.map((c) => [`${c.x},${c.y}`, c])) };
	}

	/** The camp the rules put on a tile, if any. */
	at(x: number, y: number): RuleCamp | undefined {
		const ux = this.unwrap(x);
		const uy = this.unwrap(y);
		return this.block(Math.floor(ux / this.size), Math.floor(uy / this.size)).byTile.get(`${x},${y}`);
	}

	/** A camp by id ("npc:<bx>,<by>,<slot>"), if the rules have it. */
	byId(id: string): RuleCamp | undefined {
		const m = /^npc:(\d+),(\d+),(\d+)$/.exec(id);
		if (!m) return undefined;
		const [bx, by, slot] = m.slice(1).map(Number);
		if (bx >= this.blocks || by >= this.blocks) return undefined;
		return this.block(bx, by).camps[slot];
	}

	/** Every camp within `radius` rings of `centre` (wrapping), without visiting every tile. */
	around(centre: { x: number; y: number }, radius: number): RuleCamp[] {
		const span = Math.min(this.mapSize, 2 * radius + 1);
		const axis = (c: number) => {
			const out = new Set<number>();
			const start = this.unwrap(c - radius);
			for (let i = 0; i < span; i += 1) out.add(Math.floor(((start + i) % this.mapSize) / this.size));
			return [...out];
		};
		const near = (a: number, b: number) => {
			const d = Math.abs(this.unwrap(a) - this.unwrap(b));
			return Math.min(d, this.mapSize - d) <= radius;
		};
		const out: RuleCamp[] = [];
		for (const by of axis(centre.y))
			for (const bx of axis(centre.x))
				for (const c of this.block(bx, by).camps) if (near(c.x, centre.x) && near(c.y, centre.y)) out.push(c);
		return out;
	}
}

const layouts = new Map<string, Layout>();
/** The layout of these rules (kept while they stay the same; a few sets at most: GM changes are rare). */
export function layoutOf(rules: LayoutRules, mapSize: number, wrap: (v: number) => number): Layout {
	const key = JSON.stringify([rules, mapSize]);
	let l = layouts.get(key);
	if (!l) {
		if (layouts.size > 8) layouts.clear();
		layouts.set(key, (l = new Layout(rules, mapSize, wrap)));
	}
	return l;
}

/** Tiles a side of the map and how a coordinate wraps, from its bounds (meta `map`). */
export const mapGeometry = (min: number, max: number) => {
	const size = max - min + 1;
	return { size, wrap: (v: number) => ((((v - min) % size) + size) % size) + min };
};

/**
 * Which of these rule camps stand: not gone (`removed`), nothing stored on the tile (`taken`, "x,y"), and not within a
 * capital's 3 x 3 (`capitals`: their centres; user 2026-10-18: a new player never finds a camp they cannot beat next to
 * the capital; cities get no such shelter).
 */
export function standingCamps(
	camps: RuleCamp[],
	{
		removed,
		taken,
		capitals,
		wrap,
	}: {
		removed: (id: string) => boolean;
		taken: (key: string) => boolean;
		capitals: { x: number; y: number }[];
		wrap: (v: number) => number;
	},
): RuleCamp[] {
	const ring = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(wrap(b.x - a.x)), Math.abs(wrap(b.y - a.y)));
	return camps.filter((c) => !removed(c.id) && !taken(`${c.x},${c.y}`) && !capitals.some((cap) => ring(cap, c) <= 1));
}

/** The blocks (`Layout.size` a side) a square of `radius` around `centre` touches, as id prefixes "npc:<bx>,<by>,". */
export function blockPrefixes(layout: Layout, centre: { x: number; y: number }, radius: number): string[] {
	const axis = (c: number) => {
		const out = new Set<number>();
		const span = Math.min(layout.mapSize, 2 * radius + 1);
		const start = (((c - radius) % layout.mapSize) + layout.mapSize) % layout.mapSize;
		for (let i = 0; i < span; i += 1) out.add(Math.floor(((start + i) % layout.mapSize) / layout.size));
		return [...out];
	};
	return axis(centre.y).flatMap((by) => axis(centre.x).map((bx) => `${PREFIX}${bx},${by},`));
}
