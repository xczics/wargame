#!/usr/bin/env node
/**
 * Bake a world map (docs/design/gameplay.md §4.4): terrain for every tile of the 1024 x 1024
 * wrapping map, written as a CSV to check, edit and archive before `pnpm map:import`.
 * The same seed and options always give the same map.
 *
 *   pnpm map:generate [--seed wargame] [--out .data/maps/<seed>] [--tries 5] [--option value ...]
 *
 * Output: map.csv (1024 rows x 1024 terrain ids; row 1 is y = -511, column 1 is x = -511),
 * preview.png, stats.json (shares against targets, block fairness, the options used).
 *
 * Steps: seamless 4D noise (the torus), fBm + domain warping for the land, ridged noise for
 * mountain ranges; Priority-Flood fills depressions into lakes (size-capped) and gives the
 * drainage tree, whose flow accumulation makes rivers; humidity from noise and nearness to
 * water; terrain classes by height / humidity quantiles (so shares match the targets of
 * src/plugins/terrain/data/terrains.csv); ore veins in hills and mountains; roads between
 * Poisson-disk towns (Delaunay -> spanning tree + a few loops -> A* over terrain costs);
 * small patches merged away; 64 x 64 blocks checked for fairness (bonus.csv values).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { Delaunay } from 'd3-delaunay';
import { createNoise4D } from 'simplex-noise';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = join(ROOT, 'src/plugins/terrain/data');
const W = 1024;
const N = W * W;
const MIN = -511;

/* ----- options -------------------------------------------------------------------------- */

const DEFAULTS = {
	seed: 'wargame',
	out: '',
	tries: 5,
	/** Noise features across the map (larger = smaller continents / hills). */
	scale: 1.6,
	/** How strongly the land is warped (0 = plain fBm). */
	warp: 0.35,
	/** Weight of the ridged noise that draws mountain ranges. */
	ridges: 0.6,
	/** Largest single lake, in tiles. */
	lakeMax: 2500,
	/** Least distance between road towns, in tiles (smaller = denser road network). */
	townSpacing: 14,
	/** Share of non-tree Delaunay edges added as extra roads (loops). */
	extraRoads: 0.12,
	/** Patches of one terrain smaller than this are merged into their surroundings. */
	minPatch: 6,
	/** Fairness: 64 x 64 blocks whose production value is further than this from the mean are adjusted. */
	tolerance: 0.25,
};

function parseArgs() {
	const opts = { ...DEFAULTS };
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		const key = args[i].replace(/^--/, '');
		if (!(key in DEFAULTS)) throw new Error(`Unknown option --${key} (known: ${Object.keys(DEFAULTS).join(', ')})`);
		const value = args[++i];
		opts[key] = typeof DEFAULTS[key] === 'number' ? Number(value) : value;
		if (typeof DEFAULTS[key] === 'number' && !Number.isFinite(opts[key])) throw new Error(`--${key} needs a number`);
	}
	opts.out ||= join(ROOT, '.data/maps', String(opts.seed));
	return opts;
}

/* ----- data files ----------------------------------------------------------------------- */

function csv(text) {
	const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.trimStart().startsWith('#'));
	const header = lines[0].split(',').map((h) => h.trim());
	return lines.slice(1).map((l) => Object.fromEntries(l.split(',').map((c, i) => [header[i], c.trim()])));
}
const TERRAINS = csv(readFileSync(join(DATA, 'terrains.csv'), 'utf8'));
const BONUS = Object.fromEntries(
	csv(readFileSync(join(DATA, 'bonus.csv'), 'utf8')).map(({ terrain, ...r }) => [
		terrain,
		Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v || 0)])),
	]),
);
const T = Object.fromEntries(TERRAINS.map((t, i) => [t.id, i]));
for (const id of ['grass', 'forest', 'hills', 'mountains', 'desert', 'pond', 'river', 'road', 'vein'])
	if (!(id in T)) throw new Error(`terrains.csv has no "${id}"`);
const share = (id) => Number(TERRAINS[T[id]].share || 0) / 100;

/* ----- helpers -------------------------------------------------------------------------- */

/** Deterministic random numbers from a string seed. */
function rng(seed) {
	let h = 2166136261;
	for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
	let a = h >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const wrap = (v) => ((v % W) + W) % W;
const idx = (x, y) => wrap(y) * W + wrap(x);
/** The 4 (or 8) neighbours of a cell on the torus. */
function neighbours(i, eight = false) {
	const x = i % W;
	const y = (i / W) | 0;
	const out = [idx(x + 1, y), idx(x - 1, y), idx(x, y + 1), idx(x, y - 1)];
	if (eight) out.push(idx(x + 1, y + 1), idx(x - 1, y + 1), idx(x + 1, y - 1), idx(x - 1, y - 1));
	return out;
}
/** Value below which `q` (0-1) of `values` (restricted to `where`) lie. */
function quantile(values, q, where = null) {
	const list = [];
	for (let i = 0; i < values.length; i++) if (!where || where(i)) list.push(values[i]);
	if (!list.length) return Infinity;
	list.sort((a, b) => a - b);
	return list[Math.min(list.length - 1, Math.max(0, Math.floor(q * list.length)))];
}

/** Binary min-heap of (priority, value) pairs. */
class Heap {
	constructor() {
		this.p = [];
		this.v = [];
	}
	get size() {
		return this.v.length;
	}
	push(p, v) {
		const { p: P, v: V } = this;
		let i = V.length;
		P.push(p);
		V.push(v);
		while (i > 0) {
			const j = (i - 1) >> 1;
			if (P[j] <= P[i]) break;
			[P[i], P[j]] = [P[j], P[i]];
			[V[i], V[j]] = [V[j], V[i]];
			i = j;
		}
	}
	pop() {
		const { p: P, v: V } = this;
		const top = V[0];
		const lastP = P.pop();
		const lastV = V.pop();
		if (V.length) {
			P[0] = lastP;
			V[0] = lastV;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				if (l < V.length && P[l] < P[m]) m = l;
				if (r < V.length && P[r] < P[m]) m = r;
				if (m === i) break;
				[P[i], P[m]] = [P[m], P[i]];
				[V[i], V[m]] = [V[m], V[i]];
				i = m;
			}
		}
		return top;
	}
}

/* ----- generation ----------------------------------------------------------------------- */

function generate(opts, seed) {
	const random = rng(seed);
	const noise = createNoise4D(random);
	const warpX = createNoise4D(random);
	const warpY = createNoise4D(random);
	const ridge = createNoise4D(random);
	const rangeMask = createNoise4D(random);
	const wet = createNoise4D(random);
	const ore = createNoise4D(random);

	/** Seamless noise: x and y each go once around a circle, so the map wraps on both axes. */
	const TAU = Math.PI * 2;
	const sample = (fn, x, y, freq) => {
		const a = (TAU * x) / W;
		const b = (TAU * y) / W;
		const r = (freq * opts.scale) / TAU;
		return fn(Math.cos(a) * r, Math.sin(a) * r, Math.cos(b) * r, Math.sin(b) * r);
	};
	const fbm = (fn, x, y, freq, octaves = 5) => {
		let sum = 0;
		let amp = 1;
		let norm = 0;
		for (let o = 0; o < octaves; o++) {
			sum += amp * sample(fn, x, y, freq * 2 ** o);
			norm += amp;
			amp *= 0.5;
		}
		return sum / norm;
	};

	console.log('  height...');
	const height = new Float32Array(N);
	for (let y = 0; y < W; y++) {
		for (let x = 0; x < W; x++) {
			// Domain warping: sample the land a little off, by other (smooth) noise.
			const wx = x + opts.warp * 60 * fbm(warpX, x, y, 3, 3);
			const wy = y + opts.warp * 60 * fbm(warpY, x, y, 3, 3);
			const land = fbm(noise, wx, wy, 4);
			// Ridged noise, only where the low-frequency mask says a range runs: long chains, not lone peaks.
			let rsum = 0;
			let amp = 1;
			for (let o = 0; o < 4; o++) {
				rsum += amp * (1 - Math.abs(sample(ridge, wx, wy, 6 * 2 ** o))) ** 2;
				amp *= 0.5;
			}
			const mask = Math.max(0, fbm(rangeMask, x, y, 2, 2) + 0.1);
			height[y * W + x] = land + opts.ridges * (rsum / 1.875) * mask * 1.6;
		}
	}

	console.log('  lakes and rivers...');
	// Priority-Flood from the lowest cell: every depression fills to its spill height, and
	// the order cells are reached in gives each one a downstream parent (the drainage tree).
	const filled = new Float32Array(N).fill(Infinity);
	const parent = new Int32Array(N).fill(-1);
	const order = new Int32Array(N);
	let start = 0;
	for (let i = 1; i < N; i++) if (height[i] < height[start]) start = i;
	const heap = new Heap();
	filled[start] = height[start];
	heap.push(filled[start], start);
	const done = new Uint8Array(N);
	let n = 0;
	while (heap.size) {
		const c = heap.pop();
		if (done[c]) continue;
		done[c] = 1;
		order[n++] = c;
		for (const nb of neighbours(c)) {
			if (done[nb]) continue;
			const f = Math.max(height[nb], filled[c] + 1e-6);
			if (f < filled[nb]) {
				filled[nb] = f;
				parent[nb] = c;
				heap.push(f, nb);
			}
		}
	}
	// Lakes: the deepest filled depressions, no body above lakeMax. The depth threshold is
	// lowered step by step until the lakes reach the pond share (capped bodies cover less).
	const depth = new Float32Array(N);
	for (let i = 0; i < N; i++) depth[i] = filled[i] - height[i];
	const terrain = new Uint8Array(N).fill(T.grass);
	let lakeCut = Math.max(1e-4, quantile(depth, 1 - share('pond')));
	for (let round = 0; round < 12; round++) {
		terrain.fill(T.grass);
		const seen = new Uint8Array(N);
		let lakes = 0;
		for (let i = 0; i < N; i++) {
			if (seen[i] || depth[i] < lakeCut) continue;
			const body = [];
			const queue = [i];
			seen[i] = 1;
			while (queue.length) {
				const c = queue.pop();
				body.push(c);
				for (const nb of neighbours(c)) if (!seen[nb] && depth[nb] >= lakeCut) ((seen[nb] = 1), queue.push(nb));
			}
			body.sort((a, b) => depth[b] - depth[a]);
			for (const c of body.slice(0, opts.lakeMax)) terrain[c] = T.pond;
			lakes += Math.min(body.length, opts.lakeMax);
		}
		if (lakes >= share('pond') * N * 0.95 || lakeCut <= 1e-4) break;
		lakeCut = Math.max(1e-4, lakeCut * 0.8);
	}
	// Rivers: flow accumulation down the drainage tree; the biggest flows, up to the river share.
	const flow = new Float32Array(N).fill(1);
	for (let k = N - 1; k > 0; k--) {
		const c = order[k];
		if (parent[c] >= 0) flow[parent[c]] += flow[c];
	}
	const riverCut = quantile(flow, 1 - share('river'), (i) => terrain[i] !== T.pond);
	for (let i = 0; i < N; i++) if (terrain[i] !== T.pond && flow[i] >= riverCut) terrain[i] = T.river;

	console.log('  climate and terrain classes...');
	// Distance to water (lakes, rivers), for humidity.
	const dist = new Float32Array(N).fill(Infinity);
	const q = [];
	for (let i = 0; i < N; i++) if (terrain[i] === T.pond || terrain[i] === T.river) ((dist[i] = 0), q.push(i));
	for (let h = 0; h < q.length; h++) {
		const c = q[h];
		if (dist[c] >= 40) continue;
		for (const nb of neighbours(c)) if (dist[nb] === Infinity) ((dist[nb] = dist[c] + 1), q.push(nb));
	}
	const humid = new Float32Array(N);
	for (let y = 0; y < W; y++)
		for (let x = 0; x < W; x++) {
			const i = y * W + x;
			humid[i] = fbm(wet, x, y, 3, 4) + 0.7 * Math.max(0, 1 - dist[i] / 30);
		}
	// Quantiles, not fixed thresholds, so every map comes out near the target shares.
	const land = (i) => terrain[i] === T.grass;
	const take = (values, id, highest, where) => {
		const want = share(id) * N;
		const count = (() => {
			let c = 0;
			for (let i = 0; i < N; i++) if (where(i)) c++;
			return c;
		})();
		if (!count) return;
		const cut = quantile(values, highest ? 1 - want / count : want / count, where);
		for (let i = 0; i < N; i++) if (where(i) && (highest ? values[i] >= cut : values[i] <= cut)) terrain[i] = T[id];
	};
	take(height, 'mountains', true, land);
	take(height, 'hills', true, land);
	take(humid, 'desert', false, land);
	take(humid, 'forest', true, land);
	// Ore veins: small high-frequency spots inside hills and mountains.
	const oreValue = new Float32Array(N);
	for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) oreValue[y * W + x] = sample(ore, x, y, 90);
	take(oreValue, 'vein', true, (i) => terrain[i] === T.hills || terrain[i] === T.mountains);

	console.log('  roads...');
	roads(terrain, random, opts);

	console.log('  clean-up...');
	mergeSmallPatches(terrain, opts.minPatch);

	console.log('  fairness...');
	const fairness = balance(terrain, opts.tolerance);
	return { terrain, fairness };
}

/** Towns by Poisson-disk sampling; a spanning tree of their Delaunay edges plus a few loops; A* paths. */
function roads(terrain, random, opts) {
	// Bridson's Poisson-disk sampling on the torus.
	const r = opts.townSpacing;
	const cell = r / Math.SQRT2;
	const gw = Math.ceil(W / cell);
	const grid = new Int32Array(gw * gw).fill(-1);
	const pts = [];
	const torusDist = (a, b) => {
		const dx = Math.min(Math.abs(a[0] - b[0]), W - Math.abs(a[0] - b[0]));
		const dy = Math.min(Math.abs(a[1] - b[1]), W - Math.abs(a[1] - b[1]));
		return Math.hypot(dx, dy);
	};
	const fits = (p) => {
		const gx = Math.floor(p[0] / cell);
		const gy = Math.floor(p[1] / cell);
		for (let dy = -2; dy <= 2; dy++)
			for (let dx = -2; dx <= 2; dx++) {
				const j = grid[((gy + dy + gw) % gw) * gw + ((gx + dx + gw) % gw)];
				if (j >= 0 && torusDist(pts[j], p) < r) return false;
			}
		return true;
	};
	const add = (p) => {
		pts.push(p);
		grid[Math.floor(p[1] / cell) * gw + Math.floor(p[0] / cell)] = pts.length - 1;
		return pts.length - 1;
	};
	const active = [add([random() * W, random() * W])];
	while (active.length) {
		const k = Math.floor(random() * active.length);
		const base = pts[active[k]];
		let placed = false;
		for (let t = 0; t < 30; t++) {
			const a = random() * Math.PI * 2;
			const d = r * (1 + random());
			const p = [wrap(base[0] + Math.cos(a) * d), wrap(base[1] + Math.sin(a) * d)];
			if (fits(p)) {
				active.push(add(p));
				placed = true;
				break;
			}
		}
		if (!placed) active.splice(k, 1);
	}
	// Towns sit on open land (grassland or by a river).
	const towns = pts.filter(([x, y]) => {
		const i = idx(Math.floor(x), Math.floor(y));
		return terrain[i] === T.grass || neighbours(i, true).some((nb) => terrain[nb] === T.river);
	});
	if (towns.length < 3) return;
	const del = Delaunay.from(towns);
	const edges = new Map();
	for (let t = 0; t < del.triangles.length; t += 3)
		for (const [a, b] of [
			[del.triangles[t], del.triangles[t + 1]],
			[del.triangles[t + 1], del.triangles[t + 2]],
			[del.triangles[t + 2], del.triangles[t]],
		]) {
			const key = a < b ? `${a},${b}` : `${b},${a}`;
			if (!edges.has(key)) edges.set(key, { a: Math.min(a, b), b: Math.max(a, b), d: torusDist(towns[a], towns[b]) });
		}
	// Kruskal: a spanning tree, plus a few of the other short edges so the network has loops.
	const sorted = [...edges.values()].filter((e) => e.d < 4 * r).sort((x, y) => x.d - y.d);
	const up = towns.map((_, i) => i);
	const find = (i) => (up[i] === i ? i : (up[i] = find(up[i])));
	const chosen = [];
	for (const e of sorted) {
		const [ra, rb] = [find(e.a), find(e.b)];
		if (ra !== rb) ((up[ra] = rb), chosen.push(e));
		else if (random() < opts.extraRoads) chosen.push(e);
	}
	// A* over terrain costs; existing roads are cheap, so roads merge.
	const cost = new Float32Array(TERRAINS.length).fill(2);
	Object.assign(cost, {
		[T.grass]: 1,
		[T.desert]: 1.5,
		[T.forest]: 2.5,
		[T.hills]: 3,
		[T.vein]: 3,
		[T.mountains]: 9,
		[T.river]: 6,
		[T.pond]: 30,
		[T.road]: 0.3,
	});
	const g = new Float32Array(N);
	const from = new Int32Array(N);
	const stamp = new Int32Array(N);
	let run = 0;
	for (const e of chosen) {
		run++;
		const s = idx(Math.floor(towns[e.a][0]), Math.floor(towns[e.a][1]));
		const goal = idx(Math.floor(towns[e.b][0]), Math.floor(towns[e.b][1]));
		const gx = goal % W;
		const gy = (goal / W) | 0;
		const h = (i) => {
			const dx = Math.min(Math.abs((i % W) - gx), W - Math.abs((i % W) - gx));
			const dy = Math.min(Math.abs(((i / W) | 0) - gy), W - Math.abs(((i / W) | 0) - gy));
			return (dx + dy) * 0.3; // admissible: roads cost 0.3
		};
		const open = new Heap();
		stamp[s] = run;
		g[s] = 0;
		from[s] = -1;
		open.push(h(s), s);
		let found = false;
		let budget = 400_000;
		while (open.size && budget-- > 0) {
			const c = open.pop();
			if (c === goal) {
				found = true;
				break;
			}
			for (const nb of neighbours(c)) {
				const ng = g[c] + cost[terrain[nb]];
				if (stamp[nb] !== run || ng < g[nb]) {
					stamp[nb] = run;
					g[nb] = ng;
					from[nb] = c;
					open.push(ng + h(nb), nb);
				}
			}
		}
		if (!found) continue;
		// Rivers keep flowing under the road (a bridge); lakes are never paved.
		for (let c = goal; c !== -1; c = from[c]) if (terrain[c] !== T.river && terrain[c] !== T.pond) terrain[c] = T.road;
	}
}

/** Patches of one terrain smaller than `min` take the commonest terrain around them (veins, lakes, rivers, roads stay). */
function mergeSmallPatches(terrain, min) {
	const keep = new Set([T.vein, T.pond, T.river, T.road]);
	const seen = new Uint8Array(terrain.length);
	for (let i = 0; i < terrain.length; i++) {
		if (seen[i] || keep.has(terrain[i])) continue;
		const t = terrain[i];
		const patch = [];
		const queue = [i];
		seen[i] = 1;
		while (queue.length) {
			const c = queue.pop();
			patch.push(c);
			for (const nb of neighbours(c)) if (!seen[nb] && terrain[nb] === t) ((seen[nb] = 1), queue.push(nb));
		}
		if (patch.length >= min) continue;
		const around = new Map();
		for (const c of patch)
			for (const nb of neighbours(c)) if (terrain[nb] !== t) around.set(terrain[nb], (around.get(terrain[nb]) ?? 0) + 1);
		const best = [...around].filter(([k]) => !keep.has(k)).sort((a, b) => b[1] - a[1])[0];
		if (best) for (const c of patch) terrain[c] = best[0];
	}
}

/** Production value of a tile: the sum over all resources of its multiplier, 1 + bonus (bonus.csv). */
const RESOURCES = [...new Set(Object.values(BONUS).flatMap((b) => Object.keys(b)))];
const valueOf = (terrainIndex) => RESOURCES.reduce((a, r) => a + 1 + (BONUS[TERRAINS[terrainIndex].id]?.[r] ?? 0) / 100, 0);

/**
 * Fairness over 64 x 64 blocks: poor blocks (value below mean x (1 - tolerance)) get some
 * desert turned into grassland until they reach it. Returns the block statistics after.
 */
function balance(terrain, tolerance) {
	const B = 64;
	const blocks = W / B;
	const blockValue = (bx, by) => {
		let v = 0;
		for (let y = by * B; y < (by + 1) * B; y++) for (let x = bx * B; x < (bx + 1) * B; x++) v += valueOf(terrain[y * W + x]);
		return v / (B * B);
	};
	const values = () => Array.from({ length: blocks * blocks }, (_, k) => blockValue(k % blocks, Math.floor(k / blocks)));
	let v = values();
	const mean = v.reduce((a, b) => a + b, 0) / v.length;
	let adjusted = 0;
	for (let k = 0; k < v.length; k++) {
		if (v[k] >= mean * (1 - tolerance)) continue;
		const bx = k % blocks;
		const by = Math.floor(k / blocks);
		const gain = (valueOf(T.grass) - valueOf(T.desert)) / (B * B);
		for (let y = by * B; y < (by + 1) * B && v[k] < mean * (1 - tolerance); y++)
			for (let x = bx * B; x < (bx + 1) * B && v[k] < mean * (1 - tolerance); x++)
				if (terrain[y * W + x] === T.desert) {
					terrain[y * W + x] = T.grass;
					v[k] += gain;
					adjusted++;
				}
	}
	v = values();
	const worst = Math.max(...v.map((x) => Math.abs(x - mean) / Math.abs(mean || 1)));
	return { mean, min: Math.min(...v), max: Math.max(...v), worstDeviation: worst, tilesAdjusted: adjusted, ok: worst <= tolerance };
}

/* ----- output --------------------------------------------------------------------------- */

const COLORS = {
	grass: [207, 227, 168],
	forest: [143, 191, 122],
	hills: [217, 199, 154],
	mountains: [179, 170, 156],
	desert: [239, 220, 170],
	pond: [156, 200, 224],
	river: [127, 182, 218],
	road: [216, 192, 160],
	vein: [196, 154, 122],
};

function png(terrain) {
	const raw = Buffer.alloc((W * 3 + 1) * W);
	for (let y = 0; y < W; y++) {
		// PNG rows go top-down: north (highest y) first.
		const row = W - 1 - y;
		raw[row * (W * 3 + 1)] = 0;
		for (let x = 0; x < W; x++) {
			const c = COLORS[TERRAINS[terrain[y * W + x]].id] ?? [128, 128, 128];
			raw.set(c, row * (W * 3 + 1) + 1 + x * 3);
		}
	}
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (buf) => {
		let c = 0xffffffff;
		for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type, data) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([len, body, sum]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(W, 0);
	ihdr.writeUInt32BE(W, 4);
	ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
	return Buffer.concat([
		Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
		chunk('IHDR', ihdr),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0)),
	]);
}

function main() {
	const opts = parseArgs();
	let result;
	let seed = String(opts.seed);
	for (let t = 0; t < Math.max(1, opts.tries); t++) {
		seed = t ? `${opts.seed}#${t}` : String(opts.seed);
		console.log(`Generating with seed "${seed}"...`);
		result = generate(opts, seed);
		if (result.fairness.ok) break;
		console.log(`  blocks too uneven (worst ${Math.round(result.fairness.worstDeviation * 100)}%), trying another seed`);
	}
	const { terrain, fairness } = result;
	const counts = Object.fromEntries(TERRAINS.map((t) => [t.id, 0]));
	for (let i = 0; i < N; i++) counts[TERRAINS[terrain[i]].id]++;
	const stats = {
		seed,
		options: opts,
		shares: Object.fromEntries(
			TERRAINS.map((t) => [t.id, { percent: Math.round((counts[t.id] / N) * 10000) / 100, target: Number(t.share || 0) }]),
		),
		fairness,
	};
	mkdirSync(opts.out, { recursive: true });
	const lines = [];
	for (let y = 0; y < W; y++) {
		const row = new Array(W);
		for (let x = 0; x < W; x++) row[x] = TERRAINS[terrain[y * W + x]].id;
		lines.push(row.join(','));
	}
	writeFileSync(join(opts.out, 'map.csv'), lines.join('\n') + '\n');
	writeFileSync(join(opts.out, 'preview.png'), png(terrain));
	writeFileSync(join(opts.out, 'stats.json'), JSON.stringify(stats, null, 2) + '\n');
	console.log(`\nWrote ${opts.out}/map.csv, preview.png, stats.json`);
	for (const [id, s] of Object.entries(stats.shares))
		console.log(`  ${id.padEnd(10)} ${String(s.percent).padStart(6)}%  (target ${s.target}%)`);
	console.log(
		`  fairness: worst block ${Math.round(fairness.worstDeviation * 100)}% from the mean${fairness.ok ? '' : ' (above tolerance)'}; ${fairness.tilesAdjusted} tiles adjusted`,
	);
	console.log(`  (row 1 of map.csv is y = ${MIN}, column 1 is x = ${MIN})`);
}

main();
