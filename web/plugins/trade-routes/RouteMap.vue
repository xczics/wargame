<script setup lang="ts">
// A trade route drawn as an old map (user 2026-11-16: "古地图画风"): ink paths on paper, each chapter's title over its
// part of the net, a mark for each kind of place, a seal for the bosses. Places not yet in sight (not next to a cleared
// one) show as faded dots without names. Picking a place tells the page. A long route shows a few chapters at a time
// (those around the furthest reached; the player can page back and forth), so that the map stays readable however
// many chapters a route has.
import { computed, ref, watch } from 'vue';
import type { RouteDef, RouteNode, TradeRoutesState } from '../../../src/shared/trade-routes';
import { useGame } from '../../core/game';
import { cleared, progress, visible } from './plan';

const props = defineProps<{ route: RouteDef; state?: TradeRoutesState; selected: string | null }>();
const emit = defineEmits<{ pick: [node: string] }>();
const game = useGame('trade-routes');

const PAD = 50;
const WINDOW = 4;
const last = computed(() => Math.max(1, ...props.route.nodes.map((n) => n.chapter)));
const shift = ref(0);
watch(
	() => props.route.id,
	() => (shift.value = 0),
);
/** The first chapter shown: by default the two before the furthest reached, that one and the next. */
const first = computed(() => {
	const top = Math.max(1, last.value - WINDOW + 1);
	const base = Math.min(top, Math.max(1, progress(props.state, props.route).chapter - 2));
	return Math.min(top, Math.max(1, base + shift.value));
});
const top = computed(() => Math.max(1, last.value - WINDOW + 1));
const page = (by: number) => (shift.value += by);
/** The places drawn: the chapters in the window, and the boss before it (the way in). */
const shown = computed(() =>
	props.route.nodes.filter(
		(n) => (n.chapter >= first.value && n.chapter < first.value + WINDOW) || (n.kind === 'boss' && n.chapter === first.value - 1),
	),
);
const box = computed(() => {
	const xs = shown.value.map((n) => n.x);
	const ys = shown.value.map((n) => n.y);
	const x = Math.min(...xs) - PAD;
	const y = Math.min(...ys) - PAD - 40;
	return { x, y, w: Math.max(...xs) - x + PAD, h: Math.max(...ys) - y + PAD };
});
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
/** Each chapter's title, over the middle of its places. */
const chapters = computed(() =>
	props.route.chapters
		.map((title, i) => {
			const nodes = props.route.nodes.filter((n) => n.chapter === i + 1 && n.kind !== 'start');
			const x = nodes.length ? nodes.reduce((a, n) => a + n.x, 0) / nodes.length : 0;
			return { title, x, n: i + 1 };
		})
		.filter((c) => c.n >= first.value && c.n < first.value + WINDOW),
);
const R = (n: RouteNode) => (n.kind === 'boss' ? 22 : n.kind === 'start' ? 18 : 14);
</script>

<template>
	<div class="map-window">
		<nav v-if="last > WINDOW" class="pager">
			<button type="button" :disabled="first <= 1" @click="page(-1)">{{ game.t('Earlier chapters') }}</button>
			<span class="muted">{{ game.t('Chapters {a}-{b} of {n}', { a: first, b: Math.min(last, first + WINDOW - 1), n: last }) }}</span>
			<button type="button" :disabled="first >= top" @click="page(1)">{{ game.t('Later chapters') }}</button>
		</nav>
		<svg class="map" :viewBox="`${box.x} ${box.y} ${box.w} ${box.h}`" role="img" :aria-label="game.t(route.name)">
			<defs>
				<filter id="trade-paper" x="0" y="0" width="100%" height="100%">
					<feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="3" seed="7" />
					<feColorMatrix values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0.08 0" />
					<feComposite in2="SourceGraphic" operator="over" />
				</filter>
			</defs>
			<rect class="paper" :x="box.x" :y="box.y" :width="box.w" :height="box.h" rx="18" filter="url(#trade-paper)" />
			<rect class="edge" :x="box.x + 8" :y="box.y + 8" :width="box.w - 16" :height="box.h - 16" rx="12" />
			<g v-for="c in chapters" :key="c.n" class="chapter">
				<text :x="c.x" :y="box.y + 36" text-anchor="middle">{{ game.t('Chapter {n}', { n: c.n }) }} · {{ game.t(c.title) }}</text>
			</g>
			<path v-for="p in paths" :key="p.id" :d="p.d" class="path" :class="{ open: p.open, faded: p.faded }" />
			<g
				v-for="n in shown"
				:key="n.id"
				class="node"
				:class="[n.kind, { seen: seen(n), done: done(n), here: here === n.id, selected: selected === n.id }]"
				:transform="`translate(${n.x} ${n.y})`"
				@click="seen(n) && emit('pick', n.id)"
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
						<path v-else-if="n.kind === 'story'" class="mark" d="M -7 -6 L 7 -6 L 7 6 L -7 6 Z M -4 -2 L 4 -2 M -4 2 L 4 2" />
						<path v-else class="mark" d="M -8 8 L -8 -4 Q 0 -11 8 -4 L 8 8 M -3 8 L -3 0 L 3 0 L 3 8" />
					</template>
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
.pager {
	display: flex;
	gap: 8px;
	align-items: center;
	justify-content: space-between;
	margin-bottom: 6px;
}

.map {
	display: block;
	width: 100%;
	height: auto;
	max-height: 70vh;
	user-select: none;
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

.chapter text {
	fill: var(--map-ink);
	font-size: 22px;
	letter-spacing: 2px;
	opacity: 0.8;
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
