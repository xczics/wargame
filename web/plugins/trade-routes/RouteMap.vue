<script setup lang="ts">
// A trade route drawn as an old map (user 2026-11-16: "古地图画风"): one chapter at a time (user 2026-11-20: "改成地图上仅
// 显示一个章节"; tabs for the others), its land drawn first (rivers, ranges, coasts, deserts, forests, marshes, walls:
// the content's `features`, each chapter its own: "你这个节点，画的自相似性太高了"), then ink paths, a mark for each kind
// of place, a seal for the boss. Places not yet in sight (not next to a cleared one) show as faded dots without names;
// a place with a way into another chapter has a gate. Picking a place tells the page.
import { computed, ref, watch } from 'vue';
import type { RouteDef, RouteFeature, RouteNode, TradeRoutesState } from '../../../src/shared/trade-routes';
import { useGame } from '../../core/game';
import { cleared, progress, visible } from './plan';

const props = defineProps<{ route: RouteDef; state?: TradeRoutesState; selected: string | null }>();
const emit = defineEmits<{ pick: [node: string] }>();
const game = useGame('trade-routes');

const PAD = 40;
const last = computed(() => Math.max(1, ...props.route.nodes.map((n) => n.chapter)));
/** The chapter shown: where the team stands on this route, else the furthest reached; the tabs change it. */
const chapter = ref(1);
const home = () => {
	const e = props.state?.expedition;
	const at = e?.route === props.route.id ? props.route.nodes.find((n) => n.id === e.node) : undefined;
	return at && at.kind !== 'start' ? at.chapter : progress(props.state, props.route).chapter;
};
watch(
	() => [props.route.id, props.state?.expedition?.node],
	() => (chapter.value = home()),
	{ immediate: true },
);
const reached = computed(() => progress(props.state, props.route).chapter);
const shown = computed(() => props.route.nodes.filter((n) => n.chapter === chapter.value));
const features = computed(() => (props.route.features ?? []).filter((f) => f.chapter === chapter.value));
const box = computed(() => {
	const xs = [...shown.value.map((n) => n.x), ...features.value.flatMap((f) => f.points.map((p) => p[0]))];
	const ys = [...shown.value.map((n) => n.y), ...features.value.flatMap((f) => f.points.map((p) => p[1]))];
	const x = Math.min(...xs) - PAD;
	const y = Math.min(...ys) - PAD - 30;
	return { x, y, w: Math.max(...xs) - x + PAD, h: Math.max(...ys) - y + PAD };
});
// Zoom and pan (user 2026-11-20: "要可以让用户自行放大、缩小，以及拖动哈。尤其是移动端"): the part of the chapter in view,
// as wide as the whole at most and a sixth of it at least, never past its edges. As maps do (user 2026-11-20: "应该是双
// 指捏合放大/缩小，然后双指拖动就跟着上下左右拖动"): on a touchpad two fingers pinch to zoom and slide to move it every
// way (the browser sends a pinch as a wheel with ctrlKey, a slide as a wheel with deltaX / deltaY); on a touch screen
// two fingers pinch and move it too; a mouse drags it and its wheel zooms, as on every map ("滚轮是放大缩小啊！"). A
// drag is not a pick.
const view = ref({ x: 0, y: 0, w: 1, h: 1 });
const reset = () => (view.value = { ...box.value });
watch(box, reset, { immediate: true });
const svg = ref<SVGSVGElement | null>(null);
function zoom(factor: number, cx = view.value.x + view.value.w / 2, cy = view.value.y + view.value.h / 2) {
	const b = box.value;
	const w = Math.min(b.w, Math.max(b.w / 6, view.value.w * factor));
	const h = (w * b.h) / b.w;
	const k = w / view.value.w;
	place(cx - (cx - view.value.x) * k, cy - (cy - view.value.y) * k, w, h);
}
function place(x: number, y: number, w: number, h: number) {
	const b = box.value;
	view.value = { x: Math.min(b.x + b.w - w, Math.max(b.x, x)), y: Math.min(b.y + b.h - h, Math.max(b.y, y)), w, h };
}
/** A point on the screen in the map's units. */
function toMap(clientX: number, clientY: number) {
	const r = svg.value!.getBoundingClientRect();
	return {
		x: view.value.x + ((clientX - r.left) / r.width) * view.value.w,
		y: view.value.y + ((clientY - r.top) / r.height) * view.value.h,
	};
}
const pointers = new Map<number, { x: number; y: number }>();
let dragged = false;
let pinch = 0;
let middle: { x: number; y: number } | null = null;
function down(e: PointerEvent) {
	pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
	dragged = false;
	if (pointers.size === 2) {
		const [a, b] = [...pointers.values()];
		pinch = Math.hypot(a.x - b.x, a.y - b.y);
		middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	}
}
/** Moved by so many screen pixels. */
function panBy(dx: number, dy: number) {
	const r = svg.value!.getBoundingClientRect();
	place(view.value.x - (dx / r.width) * view.value.w, view.value.y - (dy / r.height) * view.value.h, view.value.w, view.value.h);
}
function move(e: PointerEvent) {
	const last = pointers.get(e.pointerId);
	if (!last || !svg.value) return;
	if (pointers.size === 1) {
		const dx = e.clientX - last.x;
		const dy = e.clientY - last.y;
		if (!dragged && Math.hypot(dx, dy) < 4) return;
		if (!dragged) svg.value.setPointerCapture(e.pointerId);
		dragged = true;
		panBy(dx, dy);
	}
	pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
	if (pointers.size === 2) {
		const [a, b] = [...pointers.values()];
		const dist = Math.hypot(a.x - b.x, a.y - b.y);
		const now = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
		// The two fingers moved together: the map goes with them; then it zooms about where they are.
		if (middle) panBy(now.x - middle.x, now.y - middle.y);
		if (pinch > 0 && dist > 0) {
			const mid = toMap(now.x, now.y);
			zoom(pinch / dist, mid.x, mid.y);
		}
		pinch = dist;
		middle = now;
		dragged = true;
	}
}
function up(e: PointerEvent) {
	pointers.delete(e.pointerId);
	if (pointers.size < 2) ((pinch = 0), (middle = null));
}
function wheel(e: WheelEvent) {
	// Lines or pages (some mice) in pixels.
	const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (svg.value?.clientHeight ?? 400) : 1;
	const at = toMap(e.clientX, e.clientY);
	if (e.ctrlKey) {
		// A pinch that comes as a wheel (where the browser has no gesture events of its own); with them, they zoom.
		if (gestures) return;
		zoom(Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * unit * 0.01))), at.x, at.y);
	} else if (mouseWheel(e)) zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, at.x, at.y);
	else panBy(-e.deltaX * unit, -e.deltaY * unit);
}
/*
 * A pinch by the browser's own gesture events where it has them (Safari: `gesturestart` / `gesturechange` give the scale
 * the fingers made, user 2026-11-20: "应该是优先找这种浏览器原生的手势事件，没有再退回你之前说的那种猜来源算法"); else
 * the wheel with ctrlKey above. No browser says whether a wheel is a mouse's or two fingers sliding: that one is told
 * by `mouseWheel`.
 */
type Gesture = UIEvent & { scale: number; clientX: number; clientY: number };
const gestures = typeof window !== 'undefined' && 'GestureEvent' in window;
let gestureScale = 1;
function gestureStart(e: Event) {
	e.preventDefault();
	gestureScale = (e as Gesture).scale || 1;
}
function gestureChange(e: Event) {
	e.preventDefault();
	const g = e as Gesture;
	if (!g.scale) return;
	const at = toMap(g.clientX, g.clientY);
	zoom(gestureScale / g.scale, at.x, at.y);
	gestureScale = g.scale;
}
watch(svg, (el, old) => {
	if (!gestures) return;
	old?.removeEventListener('gesturestart', gestureStart);
	old?.removeEventListener('gesturechange', gestureChange);
	el?.addEventListener('gesturestart', gestureStart);
	el?.addEventListener('gesturechange', gestureChange);
});
/**
 * A mouse's wheel, not two fingers sliding on a touchpad (both come as wheel events): a mouse goes by lines or pages, or
 * by whole notches (Chrome and Safari give the old wheelDelta of ±120 a notch; a touchpad's is three times its deltaY),
 * up and down only.
 */
function mouseWheel(e: WheelEvent) {
	if (e.deltaMode !== 0) return true;
	if (e.deltaX !== 0) return false;
	const legacy = (e as WheelEvent & { wheelDeltaY?: number }).wheelDeltaY;
	if (legacy !== undefined && legacy !== 0) return legacy !== -3 * e.deltaY && Math.abs(legacy) % 120 === 0;
	return Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50;
}
const pick = (n: RouteNode) => {
	if (!dragged && seen(n)) emit('pick', n.id);
};

/** Places with a way into another chapter (the way in from the boss before, the way on from this one's). */
const gates = computed(() => {
	const ids = new Set(shown.value.map((n) => n.id));
	const out = new Set<string>();
	for (const [a, b] of props.route.edges) {
		if (ids.has(a) && !ids.has(b)) out.add(a);
		if (ids.has(b) && !ids.has(a)) out.add(b);
	}
	return out;
});

/** A smooth line through points (Catmull-Rom as cubic Béziers), closed or not. */
function smooth(points: [number, number][], closed: boolean) {
	if (points.length < 2) return '';
	const pts = closed ? [points[points.length - 1], ...points, points[0], points[1]] : [points[0], ...points, points[points.length - 1]];
	let d = `M ${pts[1][0]} ${pts[1][1]}`;
	for (let i = 1; i < pts.length - 2; i++) {
		const [p0, p1, p2, p3] = [pts[i - 1], pts[i], pts[i + 1], pts[i + 2]];
		d += ` C ${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]} ${p2[1]}`;
	}
	return closed ? `${d} Z` : d;
}
const AREAS = new Set(['sea', 'lake', 'land', 'desert', 'forest', 'marsh']);
/** Peaks along a range: a little ink mountain every so often, alternately larger. */
function peaks(points: [number, number][]) {
	const out: string[] = [];
	let k = 0;
	for (let i = 0; i < points.length - 1; i++) {
		const [ax, ay] = points[i];
		const [bx, by] = points[i + 1];
		const len = Math.hypot(bx - ax, by - ay);
		for (let t = 0; t < len; t += 30) {
			const x = ax + ((bx - ax) * t) / len;
			const y = ay + ((by - ay) * t) / len;
			const h = k++ % 2 ? 16 : 24;
			out.push(`M ${x - h * 0.8} ${y + 6} L ${x} ${y + 6 - h} L ${x + h * 0.8} ${y + 6} M ${x} ${y + 6 - h} L ${x + h * 0.25} ${y + 6}`);
		}
	}
	return out.join(' ');
}
const drawn = computed(() =>
	features.value.map((f: RouteFeature, i) => ({
		key: `${f.kind}-${i}`,
		kind: f.kind,
		d: f.kind === 'range' ? peaks(f.points) : smooth(f.points, AREAS.has(f.kind)),
	})),
);
const byId = computed(() => new Map(shown.value.map((n) => [n.id, n])));
const here = computed(() => (props.state?.expedition?.route === props.route.id ? props.state.expedition.node : null));
const seen = (n: RouteNode) => visible(props.state, props.route, n);
const done = (n: RouteNode) => cleared(props.state, props.route, n.id);

/** Paths as gentle ink curves (bent a little to one side, the same way every time). */
const paths = computed(() =>
	props.route.edges
		.filter(([a, b]) => byId.value.has(a) && byId.value.has(b))
		.map(([a, b]) => {
			const p = byId.value.get(a)!;
			const q = byId.value.get(b)!;
			const mx = (p.x + q.x) / 2 + (q.y - p.y) * 0.08;
			const my = (p.y + q.y) / 2 - (q.x - p.x) * 0.08;
			return {
				id: `${a}|${b}`,
				d: `M ${p.x} ${p.y} Q ${mx} ${my} ${q.x} ${q.y}`,
				open: done(p) && done(q),
				faded: !seen(p) || !seen(q),
			};
		}),
);
const title = computed(() => props.route.chapters[chapter.value - 1]);
const R = (n: RouteNode) => (n.kind === 'boss' ? 22 : n.kind === 'start' ? 18 : 14);
</script>

<template>
	<div class="map-window">
		<nav v-if="last > 1" class="tabs-chapters">
			<button
				v-for="c in last"
				:key="c"
				type="button"
				class="small"
				:class="chapter === c ? 'primary' : 'secondary'"
				:disabled="c > reached + 1"
				@click="chapter = c"
			>
				{{ game.t('Chapter {n}', { n: c }) }}
			</button>
		</nav>
		<div class="zoom">
			<button type="button" class="small secondary" :aria-label="game.t('Zoom in')" @click="zoom(1 / 1.4)">+</button>
			<button type="button" class="small secondary" :aria-label="game.t('Zoom out')" @click="zoom(1.4)">−</button>
			<button type="button" class="small secondary" @click="reset">{{ game.t('Whole map') }}</button>
		</div>
		<svg
			ref="svg"
			class="map"
			:viewBox="`${view.x} ${view.y} ${view.w} ${view.h}`"
			role="img"
			:aria-label="game.t(route.name)"
			@pointerdown="down"
			@pointermove="move"
			@pointerup="up"
			@pointercancel="up"
			@wheel.prevent="wheel"
		>
			<defs>
				<filter id="trade-paper" x="0" y="0" width="100%" height="100%">
					<feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="3" seed="7" />
					<feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.08 0" />
					<feComposite in2="SourceGraphic" operator="over" />
				</filter>
				<pattern id="trade-dots" width="14" height="14" patternUnits="userSpaceOnUse">
					<circle cx="3" cy="3" r="1.2" class="dot" />
					<circle cx="10" cy="9" r="1" class="dot" />
				</pattern>
				<pattern id="trade-waves" width="36" height="16" patternUnits="userSpaceOnUse">
					<path d="M 2 8 q 5 -5 10 0 t 10 0" class="wave" />
				</pattern>
				<pattern id="trade-trees" width="26" height="24" patternUnits="userSpaceOnUse">
					<path d="M 6 18 L 11 6 L 16 18 Z M 11 18 L 11 22" class="tree" />
					<path d="M 18 10 L 22 2 L 26 10 Z" class="tree" />
				</pattern>
				<pattern id="trade-reeds" width="20" height="14" patternUnits="userSpaceOnUse">
					<path d="M 2 12 L 4 4 M 6 12 L 6 5 M 10 12 L 12 6 M 0 12 L 14 12" class="reed" />
				</pattern>
			</defs>
			<rect class="paper" :x="box.x" :y="box.y" :width="box.w" :height="box.h" rx="18" filter="url(#trade-paper)" />
			<g class="land">
				<path v-for="f in drawn" :key="f.key" :d="f.d" :class="`feature ${f.kind}`" />
			</g>
			<rect class="edge" :x="box.x + 8" :y="box.y + 8" :width="box.w - 16" :height="box.h - 16" rx="12" />
			<text class="title" :x="box.x + box.w / 2" :y="box.y + 34" text-anchor="middle">
				{{ game.t('Chapter {n}', { n: chapter }) }}
				<template v-if="title">· {{ game.t(title) }}</template>
			</text>
			<path v-for="p in paths" :key="p.id" :d="p.d" class="path" :class="{ open: p.open, faded: p.faded }" />
			<g
				v-for="n in shown"
				:key="n.id"
				class="node"
				:class="[n.kind, { seen: seen(n), done: done(n), here: here === n.id, selected: selected === n.id }]"
				:transform="`translate(${n.x} ${n.y})`"
				@click="pick(n)"
			>
				<template v-if="seen(n)">
					<circle v-if="selected === n.id" class="ring" :r="R(n) + 7" />
					<!-- Each kind its mark: crossed blades, a seal, a well, a lozenge, a coin, a scroll, a gate. -->
					<template v-if="n.kind === 'boss'">
						<rect class="seal" :x="-R(n)" :y="-R(n)" :width="2 * R(n)" :height="2 * R(n)" rx="4" />
						<path class="seal-mark" d="M -10 -10 L 10 10 M 10 -10 L -10 10 M 0 -13 L 0 13" />
					</template>
					<template v-else>
						<circle class="disc" :r="R(n)" />
						<path v-if="n.kind === 'enemy'" class="mark" d="M -7 -7 L 7 7 M 7 -7 L -7 7" />
						<path v-else-if="n.kind === 'supply'" class="mark" d="M -7 -2 L 7 -2 L 5 7 L -5 7 Z M -4 -6 L 4 -6" />
						<path v-else-if="n.kind === 'key'" class="mark" d="M 0 -8 L 7 0 L 0 8 L -7 0 Z" />
						<g v-else-if="n.kind === 'merchant'">
							<circle class="mark" r="7" />
							<rect class="mark" x="-2.5" y="-2.5" width="5" height="5" />
						</g>
						<path v-else-if="n.kind === 'lair'" class="mark" d="M -9 7 Q 0 -14 9 7 Z M -4 7 Q 0 -2 4 7 M -6 -8 L -3 -4 M 6 -8 L 3 -4" />
						<path v-else-if="n.kind === 'story'" class="mark" d="M -7 -6 L 7 -6 L 7 6 L -7 6 Z M -4 -2 L 4 -2 M -4 2 L 4 2" />
						<path v-else class="mark" d="M -8 8 L -8 -4 Q 0 -11 8 -4 L 8 8 M -3 8 L -3 0 L 3 0 L 3 8" />
					</template>
					<path v-if="gates.has(n.id)" class="gate" :d="`M ${R(n) + 4} -8 L ${R(n) + 14} 0 L ${R(n) + 4} 8`" />
					<text class="label" :y="R(n) + 18" text-anchor="middle">{{ n.name ? game.t(n.name) : n.id }}</text>
					<g v-if="here === n.id" class="team" :transform="`translate(0 ${-R(n) - 14})`">
						<path d="M 0 10 L 0 -10 L 14 -6 L 0 -2" />
					</g>
				</template>
				<circle v-else class="fog" r="5" />
			</g>
		</svg>
	</div>
</template>

<style scoped>
.tabs-chapters {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	margin-bottom: 6px;
}

/* The land: water washed in, ranges in ink, deserts stippled, forests and marshes in little marks. */
.feature {
	fill: none;
	stroke: none;
}

.feature.river {
	stroke: var(--map-water);
	stroke-width: 9;
	stroke-linecap: round;
	opacity: 0.85;
}

.feature.sea,
.feature.lake {
	fill: var(--map-water);
	stroke: var(--map-ink);
	stroke-width: 1.5;
	opacity: 0.55;
}

.feature.land {
	fill: var(--map-paper);
	stroke: var(--map-ink);
	stroke-width: 1.5;
}

.feature.range {
	stroke: var(--map-ink);
	stroke-width: 1.6;
	stroke-linejoin: round;
	opacity: 0.55;
}

.feature.desert {
	fill: url(#trade-dots);
	opacity: 0.7;
}

.feature.forest {
	fill: url(#trade-trees);
	opacity: 0.6;
}

.feature.marsh {
	fill: url(#trade-reeds);
	opacity: 0.6;
}

.feature.wall {
	stroke: var(--map-ink);
	stroke-width: 5;
	stroke-dasharray: 6 4;
	opacity: 0.5;
}

.feature.road {
	stroke: var(--map-faded);
	stroke-width: 2;
	stroke-dasharray: 2 5;
}

.dot,
.tree,
.reed,
.wave {
	fill: none;
	stroke: var(--map-ink);
	stroke-width: 1;
}

.dot {
	fill: var(--map-ink);
	stroke: none;
}

.title {
	fill: var(--map-ink);
	font-size: 24px;
	letter-spacing: 2px;
	opacity: 0.85;
}

.gate {
	fill: none;
	stroke: var(--map-ink);
	stroke-width: 2.5;
}

.map-window {
	position: relative;
}

.zoom {
	position: absolute;
	right: 12px;
	top: 48px;
	z-index: 1;
	display: flex;
	gap: 4px;
}

.map {
	display: block;
	width: 100%;
	height: auto;
	max-height: 70vh;
	user-select: none;
	touch-action: none;
	cursor: grab;
	font-family: 'Songti SC', 'STSong', 'SimSun', serif;
}

.paper {
	fill: var(--map-paper);
}

.edge {
	fill: none;
	stroke: var(--map-paper-edge);
	stroke-width: 3;
}

.path {
	fill: none;
	stroke: var(--map-ink);
	stroke-width: 2.5;
	stroke-dasharray: 7 6;
	stroke-linecap: round;
}

.path.open {
	stroke-dasharray: none;
}

.path.faded {
	stroke: var(--map-faded);
	opacity: 0.5;
}

.node.seen {
	cursor: pointer;
}

.disc {
	fill: var(--map-paper);
	stroke: var(--map-ink);
	stroke-width: 2.5;
}

.node.done .disc {
	fill: var(--map-paper-edge);
}

.mark {
	fill: none;
	stroke: var(--map-ink);
	stroke-width: 2;
	stroke-linejoin: round;
}

.seal {
	fill: var(--seal);
	stroke: var(--map-ink);
	stroke-width: 2;
}

.node.done .seal {
	opacity: 0.55;
}

.seal-mark {
	stroke: var(--map-paper);
	stroke-width: 2.5;
}

.label {
	fill: var(--map-ink);
	font-size: 15px;
	paint-order: stroke;
	stroke: var(--map-paper);
	stroke-width: 4px;
}

.ring {
	fill: none;
	stroke: var(--accent);
	stroke-width: 3;
}

.team path {
	fill: var(--accent);
	stroke: var(--map-ink);
	stroke-width: 1.5;
}

.fog {
	fill: var(--map-faded);
	opacity: 0.6;
}
</style>
