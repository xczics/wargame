<script setup lang="ts">
// The GM's editor for rule opaque-research.groups (in the rules page, slot "gm-rule-editors"): the 256 dimensions as a
// ring cut into as many segments as the GM likes (1-256, as even as can be); pick a segment, then put in it any bonuses (each its percent a step), combined
// as the GM likes. The bonuses on offer and the steps they suggest come from the static texts.
import { computed, ref } from 'vue';
import type { OpaqueGroup, OpaqueTexts } from '../../../src/shared/api';
import { useGame } from '../../core/game';

const props = defineProps<{ value: unknown }>();
const emit = defineEmits<{ update: [value: { count: number; groups: OpaqueGroup[] }] }>();
const game = useGame('opaque-research');
const texts = computed(() => game.static<OpaqueTexts>('opaque-research.texts'));
const rule = computed(() => props.value as { count: number; groups: OpaqueGroup[] });
const selected = ref(0);
const CATEGORIES = ['production', 'upkeep', 'time', 'battle'];

const nameOf = (id: string) => (texts.value?.bonuses[id] ? game.t(texts.value.bonuses[id].name) : id);
const partText = (p: { bonus: string; step: number }) =>
	`${nameOf(p.bonus)} ${texts.value?.bonuses[p.bonus]?.direction === 'decrease' ? '−' : '+'}${p.step}%`;
/** The bonuses on offer, by category (in the order of the texts), for the picker. */
const offer = computed(() => {
	const all = Object.entries(texts.value?.bonuses ?? {});
	const cats = [...new Set([...CATEGORIES, ...all.map(([, b]) => b.category)])];
	return cats
		.map((c) => ({ category: c, items: all.filter(([, b]) => b.category === c).map(([id]) => ({ id, name: nameOf(id) })) }))
		.filter((c) => c.items.length);
});

const set = (groups: OpaqueGroup[]) => emit('update', { count: groups.length, groups });
const clone = () => rule.value.groups.map((g) => g.map((p) => ({ ...p })));
function setCount(raw: number) {
	const n = Math.min(256, Math.max(1, Math.round(raw) || 1));
	const old = rule.value.groups;
	// More segments: the pattern repeats round the ring; fewer: the first ones stay.
	set(Array.from({ length: n }, (_, i) => (old.length ? old[i % old.length].map((p) => ({ ...p })) : [])));
	selected.value = Math.min(selected.value, n - 1);
}
const adding = ref('');
const copyTarget = ref<number>(0);
function add() {
	if (!adding.value) return;
	const g = clone();
	if (!g[selected.value].some((p) => p.bonus === adding.value))
		g[selected.value].push({ bonus: adding.value, step: texts.value?.bonuses[adding.value]?.step ?? 1 });
	adding.value = '';
	set(g);
}
function setStep(i: number, step: number) {
	const g = clone();
	g[selected.value][i].step = Math.max(0, step);
	set(g);
}
function remove(i: number) {
	const g = clone();
	g[selected.value].splice(i, 1);
	set(g);
}
function copyTo(target: number) {
	const g = clone();
	g[target] = g[selected.value].map((p) => ({ ...p }));
	set(g);
}

// The ring: segment i from angle i/n to (i+1)/n of a turn, clockwise from the top.
const R = 90;
const r = 54;
const point = (radius: number, turn: number) => {
	const a = turn * 2 * Math.PI - Math.PI / 2;
	return `${100 + radius * Math.cos(a)} ${100 + radius * Math.sin(a)}`;
};
// Segment i starts at dimension ceil(256 i / n), as the server groups them (sizes differ by one at most).
const startOf = (i: number, n: number) => Math.floor((i * 256 + n - 1) / n);
const sizeText = computed(() => {
	const n = rule.value.groups.length;
	const sizes = new Set(Array.from({ length: n }, (_, i) => startOf(i + 1, n) - startOf(i, n)));
	return game.t('Each segment is {n} dimensions in a row round the ring.', { n: [...sizes].sort((a, b) => a - b).join(' / ') });
});
const segments = computed(() => {
	const n = rule.value.groups.length;
	return rule.value.groups.map((g, i) => {
		const [a, b] = [startOf(i, n) / 256, startOf(i + 1, n) / 256];
		const mid = (a + b) / 2;
		const [lx, ly] = point((R + r) / 2, mid)
			.split(' ')
			.map(Number);
		return {
			i,
			path: `M ${point(R, a)} A ${R} ${R} 0 0 1 ${point(R, b)} L ${point(r, b)} A ${r} ${r} 0 0 0 ${point(r, a)} Z`,
			category: texts.value?.bonuses[g[0]?.bonus]?.category ?? 'empty',
			lx,
			ly,
		};
	});
});
</script>

<template>
	<div class="gm-groups">
		<div class="top">
			<label>
				{{ game.t('Segments') }}
				<input
					type="number"
					min="1"
					max="256"
					:value="rule.groups.length"
					@change="setCount(Number(($event.target as HTMLInputElement).value))"
				/>
			</label>
			<button v-for="n in [4, 8, 16, 32, 64]" :key="n" type="button" class="small secondary" @click="setCount(n)">{{ n }}</button>
			<span class="muted">{{ sizeText }}</span>
		</div>
		<div class="body">
			<svg viewBox="0 0 200 200" class="ring" role="list">
				<g v-for="s in segments" :key="s.i" role="listitem" @click="selected = s.i">
					<path :d="s.path" :class="['seg', `cat-${s.category}`, { on: selected === s.i }]" />
					<text v-if="segments.length <= 32" :x="s.lx" :y="s.ly" class="num">{{ s.i + 1 }}</text>
				</g>
			</svg>
			<div class="edit">
				<h4>{{ game.t('Segment {n}', { n: selected + 1 }) }}</h4>
				<p v-if="!rule.groups[selected]?.length" class="muted">{{ game.t('Gives nothing yet.') }}</p>
				<div v-for="(p, i) in rule.groups[selected]" :key="p.bonus" class="part">
					<span class="name">{{ nameOf(p.bonus) }}</span>
					<input type="number" min="0" step="0.1" :value="p.step" @change="setStep(i, Number(($event.target as HTMLInputElement).value))" />
					<span class="muted">{{ game.t('% a step') }}</span>
					<button type="button" class="small secondary" @click="remove(i)">{{ game.t('Remove') }}</button>
				</div>
				<div class="add">
					<select v-model="adding">
						<option value="">{{ game.t('Add a bonus…') }}</option>
						<optgroup v-for="c in offer" :key="c.category" :label="game.t(`category:${c.category}`)">
							<option v-for="b in c.items" :key="b.id" :value="b.id">{{ b.name }}</option>
						</optgroup>
					</select>
					<button type="button" class="small" :disabled="!adding" @click="add">{{ game.t('Add') }}</button>
				</div>
				<div class="copy">
					<span class="muted">{{ game.t('Copy to segment') }}</span>
					<input v-model.number="copyTarget" type="number" min="1" :max="rule.groups.length" />
					<button
						type="button"
						class="small secondary"
						:disabled="!copyTarget || copyTarget < 1 || copyTarget > rule.groups.length || copyTarget === selected + 1"
						@click="copyTo(copyTarget - 1)"
					>
						{{ game.t('Copy') }}
					</button>
				</div>
			</div>
		</div>
		<ol class="summary">
			<li v-for="(g, i) in rule.groups" :key="i" :class="{ on: selected === i }" @click="selected = i">
				{{ g.length ? g.map(partText).join(game.t(', ')) : game.t('Gives nothing yet.') }}
			</li>
		</ol>
	</div>
</template>

<style scoped>
.gm-groups {
	display: grid;
	gap: 8px;
}

.top {
	display: flex;
	gap: 12px;
	align-items: center;
	flex-wrap: wrap;
}

.top input,
.copy input {
	width: 80px;
}

.body {
	display: flex;
	gap: 16px;
	flex-wrap: wrap;
	align-items: flex-start;
}

.ring {
	width: 220px;
	max-width: 100%;
	flex: none;
}

.seg {
	stroke: var(--surface);
	stroke-width: 1.5;
	cursor: pointer;
	fill: var(--border);
}

.seg.on {
	stroke: var(--text);
	stroke-width: 2.5;
}

.cat-production {
	fill: var(--rarity-green);
}

.cat-upkeep {
	fill: var(--accent);
}

.cat-time {
	fill: var(--rarity-blue);
}

.cat-battle {
	fill: var(--danger);
}

.num {
	font-size: 11px;
	text-anchor: middle;
	dominant-baseline: middle;
	pointer-events: none;
	fill: var(--text);
}

.edit {
	flex: 1;
	min-width: 260px;
	display: grid;
	gap: 6px;
}

.edit h4 {
	margin: 0;
}

.part,
.add,
.copy {
	display: flex;
	gap: 6px;
	align-items: center;
	flex-wrap: wrap;
}

.part .name {
	flex: 1;
	min-width: 140px;
}

.part input {
	width: 70px;
}

.add select {
	flex: 1;
	min-width: 180px;
}

.summary {
	margin: 0;
	padding-left: 24px;
}

.summary li {
	cursor: pointer;
}

.summary li.on {
	font-weight: 600;
}
</style>
