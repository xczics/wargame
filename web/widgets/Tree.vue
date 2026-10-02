<script setup lang="ts">
// Generic widget "ui.tree": groups (e.g. branches) of columns (e.g. tiers) of nodes from the server's
// view, with a line from each prerequisite in the same group (highlighted when met) and tags for those
// elsewhere. Node states: done, active (under way), locked (faded), started, open.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TreeData } from '../../src/shared/ui';
import { useGame } from '../core/game';
import ActionLabel from './ActionLabel.vue';
import { runAction } from './actions';
import Line from './Line.vue';
import { uiText } from './text';

const props = defineProps<{ view: string }>();
const game = useGame();
const data = computed(() => (game.state.value?.views[props.view] ?? null) as TreeData | null);

const sections = ref<HTMLElement[]>([]);
const lines = ref<Record<string, { d: string; met: boolean }[]>>({});
const size = ref<Record<string, { w: number; h: number }>>({});
function draw() {
	const out: typeof lines.value = {};
	const sizes: typeof size.value = {};
	for (const section of sections.value) {
		const id = section.dataset.group!;
		const group = data.value?.groups.find((g) => g.id === id);
		const box = section.getBoundingClientRect();
		sizes[id] = { w: box.width, h: box.height };
		const card = (node: string) => section.querySelector<HTMLElement>(`[data-node="${CSS.escape(node)}"]`)?.getBoundingClientRect();
		out[id] = [];
		for (const n of group?.columns.flatMap((c) => c.nodes) ?? []) {
			const to = card(n.id);
			if (!to) continue;
			for (const r of n.requires ?? []) {
				const from = card(r.id);
				if (!from) continue;
				const x1 = from.right - box.left;
				const y1 = from.top + from.height / 2 - box.top;
				const x2 = to.left - box.left;
				const y2 = to.top + to.height / 2 - box.top;
				const mid = (x1 + x2) / 2;
				out[id].push({ d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`, met: r.met });
			}
		}
	}
	lines.value = out;
	size.value = sizes;
}
let observer: ResizeObserver | undefined;
onMounted(() => {
	observer = new ResizeObserver(() => draw());
	watch(
		sections,
		(list) => {
			observer?.disconnect();
			for (const s of list) observer?.observe(s);
		},
		{ immediate: true, deep: true },
	);
});
onBeforeUnmount(() => observer?.disconnect());
watch(data, () => nextTick(draw), { immediate: true });
</script>

<template>
	<section v-if="data" class="card">
		<h2 v-if="data.title">{{ uiText(game, data.title) }}</h2>
		<div v-for="g in data.groups" :key="g.id" ref="sections" class="group" :data-group="g.id">
			<svg class="lines" :width="size[g.id]?.w ?? 0" :height="size[g.id]?.h ?? 0" aria-hidden="true">
				<path v-for="(l, i) in lines[g.id] ?? []" :key="i" :d="l.d" :class="{ met: l.met }" />
			</svg>
			<h3 v-if="g.label">{{ uiText(game, g.label) }}</h3>
			<div class="columns" :style="{ gridTemplateColumns: `repeat(${g.columns.length}, minmax(180px, 1fr))` }">
				<div v-for="(c, i) in g.columns" :key="i" class="column">
					<small v-if="c.label" class="column-name">{{ uiText(game, c.label) }}</small>
					<div v-for="n in c.nodes" :key="n.id" class="node" :class="n.state" :data-node="n.id">
						<div class="head">
							<strong>{{ uiText(game, n.title) }}</strong>
							<small v-if="n.badge">{{ uiText(game, n.badge) }}</small>
						</div>
						<small v-if="n.quote" class="quote">{{ uiText(game, n.quote) }}</small>
						<Line v-for="(l, k) in n.lines ?? []" :key="k" :line="l" />
						<div v-if="n.tags?.length" class="tags">
							<small v-for="(t, k) in n.tags" :key="k" class="tag" :class="{ met: t.met }">{{ uiText(game, t.text) }}</small>
						</div>
						<div v-if="n.actions?.length" class="actions">
							<button
								v-for="(a, k) in n.actions"
								:key="k"
								type="button"
								class="small"
								:disabled="!!a.blocked"
								:title="a.blocked ? uiText(game, a.blocked) : undefined"
								@click="runAction(game, a)"
							>
								<ActionLabel :action="a" />
							</button>
						</div>
					</div>
				</div>
			</div>
		</div>
		<Line v-for="(n, i) in data.notes ?? []" :key="`n${i}`" :line="n" />
	</section>
</template>

<style scoped>
.group {
	position: relative;
	padding-top: 4px;
}

.group + .group {
	margin-top: 16px;
	border-top: 1px solid var(--border);
	padding-top: 12px;
}

.group h3 {
	margin: 0 0 6px;
}

.lines {
	position: absolute;
	inset: 0;
	pointer-events: none;
	overflow: visible;
}

.lines path {
	fill: none;
	stroke: var(--border);
	stroke-width: 2;
}

.lines path.met {
	stroke: var(--info);
}

.columns {
	display: grid;
	gap: 28px;
	overflow-x: auto;
}

.column {
	display: grid;
	gap: 10px;
	align-content: start;
}

.column-name {
	color: var(--muted);
	font-weight: 600;
}

.node {
	position: relative;
	display: grid;
	gap: 3px;
	padding: 8px 10px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
	background: var(--surface);
}

.node.done {
	border-color: var(--info);
}

.node.active {
	border-color: var(--accent);
	box-shadow: 0 0 0 1px var(--accent);
}

.node.locked {
	opacity: 0.65;
}

.head {
	display: flex;
	justify-content: space-between;
	gap: 6px;
	align-items: baseline;
}

.quote {
	color: var(--muted);
	font-style: italic;
}

.tags {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
}

.tag {
	padding: 0 6px;
	border-radius: 999px;
	border: 1px dashed var(--accent);
	color: var(--accent);
}

.tag.met {
	border-style: solid;
	color: var(--info);
	border-color: var(--info);
}

.actions {
	display: flex;
	gap: 6px;
}
</style>
