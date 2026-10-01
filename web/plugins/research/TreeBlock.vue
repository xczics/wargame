<script setup lang="ts">
// The tech tree, read only: each branch in tier columns, lines from a tech to what it opens
// within the branch, and tags for prerequisites in the other branch. Research is started at
// an institute (LabBlock).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { TechInfo } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import { techText } from './text';

const game = useGame();
const text = techText(game);
const tree = computed(() => game.view('research.tree'));
const techs = computed(() => tree.value?.techs ?? []);
const byId = computed(() => new Map(techs.value.map((t) => [t.id, t])));
const researching = computed(() => new Map((tree.value?.all ?? []).map((j) => [j.tech, j.targetLevel])));

/** Branches in the order their first tech appears; techs outside the tree go to "Other". */
const branches = computed(() => {
	const out: { name: string; tiers: TechInfo[][] }[] = [];
	for (const t of techs.value) {
		const name = t.branch ?? 'Other';
		let b = out.find((x) => x.name === name);
		if (!b) out.push((b = { name, tiers: [] }));
		const i = (t.tier ?? 1) - 1;
		(b.tiers[i] ??= []).push(t);
	}
	for (const b of out)
		b.tiers = Array.from({ length: b.tiers.length }, (_, i) => (b.tiers[i] ?? []).sort((x, y) => (x.order ?? 0) - (y.order ?? 0)));
	return out;
});
const sameBranch = (t: TechInfo, req: string) => (byId.value.get(req)?.branch ?? 'Other') === (t.branch ?? 'Other');
const state = (t: TechInfo) =>
	researching.value.has(t.id) ? 'active' : !t.next ? 'done' : t.next.locked ? 'locked' : t.level ? 'started' : 'open';

/* ----- prerequisite lines (within a branch) ---------------------------------------- */

const sections = ref<HTMLElement[]>([]);
const lines = ref<Record<string, { d: string; met: boolean }[]>>({});
const size = ref<Record<string, { w: number; h: number }>>({});
function draw() {
	const out: typeof lines.value = {};
	const sizes: typeof size.value = {};
	for (const section of sections.value) {
		const name = section.dataset.branch!;
		const box = section.getBoundingClientRect();
		sizes[name] = { w: box.width, h: box.height };
		const card = (id: string) => section.querySelector<HTMLElement>(`[data-tech="${id}"]`)?.getBoundingClientRect();
		out[name] = [];
		for (const t of techs.value) {
			const to = card(t.id);
			if (!to) continue;
			for (const [req, level] of Object.entries(t.requires)) {
				const from = card(req);
				if (!from) continue; // in the other branch: shown as a tag
				const x1 = from.right - box.left;
				const y1 = from.top + from.height / 2 - box.top;
				const x2 = to.left - box.left;
				const y2 = to.top + to.height / 2 - box.top;
				const mid = (x1 + x2) / 2;
				out[name].push({ d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`, met: (byId.value.get(req)?.level ?? 0) >= level });
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
watch(techs, () => nextTick(draw), { immediate: true });
</script>

<template>
	<section v-if="tree" class="card">
		<h2>{{ game.t('Tech tree') }}</h2>
		<div v-for="b in branches" :key="b.name" ref="sections" class="branch" :data-branch="b.name">
			<svg class="lines" :width="size[b.name]?.w ?? 0" :height="size[b.name]?.h ?? 0" aria-hidden="true">
				<path v-for="(l, i) in lines[b.name] ?? []" :key="i" :d="l.d" :class="{ met: l.met }" />
			</svg>
			<h3>{{ game.t(b.name) }}</h3>
			<div class="tiers" :style="{ gridTemplateColumns: `repeat(${b.tiers.length}, minmax(180px, 1fr))` }">
				<div v-for="(tier, i) in b.tiers" :key="i" class="tier">
					<small class="tier-name">{{ game.t(`research-tier:${i + 1}`) }}</small>
					<div v-for="t in tier" :key="t.id" class="tech" :class="state(t)" :data-tech="t.id">
						<div class="head">
							<strong>{{ game.t(t.name) }}</strong>
							<small>{{ t.level }}/{{ t.maxLevel }}</small>
						</div>
						<small v-if="t.quote" class="quote">{{ game.t(t.quote) }}</small>
						<small v-for="u in t.unlocks" :key="u.building">{{ text.unlock(t, u) }}</small>
						<small v-for="(e, k) in t.effects" :key="k">{{ text.effect(e) }} {{ game.t('per level') }}</small>
						<div v-if="Object.keys(t.requires).some((r) => !sameBranch(t, r))" class="tags">
							<small
								v-for="(level, req) in t.requires"
								v-show="!sameBranch(t, String(req))"
								:key="req"
								class="tag"
								:class="{ met: (byId.get(String(req))?.level ?? 0) >= level }"
								>{{ game.t(byId.get(String(req))?.name ?? String(req)) }} {{ level }}</small
							>
						</div>
						<small v-if="researching.get(t.id)" class="active-text">{{
							game.t('Researching Lv {n}', { n: researching.get(t.id)! })
						}}</small>
						<small v-else-if="t.next?.locked" class="blocked">{{ game.t(t.next.locked) }}</small>
					</div>
				</div>
			</div>
		</div>
		<small class="muted">{{
			game.t('Start research at an institute (open it on the Overview page). Tags: prerequisites in the other branch.')
		}}</small>
	</section>
</template>

<style scoped>
.branch {
	position: relative;
	padding-top: 4px;
}

.branch + .branch {
	margin-top: 16px;
	border-top: 1px solid var(--border);
	padding-top: 12px;
}

.branch h3 {
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

.tiers {
	display: grid;
	gap: 28px;
	overflow-x: auto;
}

.tier {
	display: grid;
	gap: 10px;
	align-content: start;
}

.tier-name {
	color: var(--muted);
	font-weight: 600;
}

.tech {
	position: relative;
	display: grid;
	gap: 3px;
	padding: 8px 10px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
	background: var(--surface);
}

.tech.done {
	border-color: var(--info);
}

.tech.active {
	border-color: var(--accent);
	box-shadow: 0 0 0 1px var(--accent);
}

.tech.locked {
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

.active-text {
	color: var(--accent);
}

.blocked {
	color: var(--danger);
}
</style>
