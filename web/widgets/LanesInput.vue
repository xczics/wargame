<script setup lang="ts">
// Generic form field widget "ui.lanes-input" (data: LanesInputData): shares a pool over lanes, e.g. an
// army's formation. Each lane picks a group and takes counts of its options; options of no group go in
// an extra box. Every box shows how many are still free: the pool minus what the other boxes hold.
import { computed, reactive, watch } from 'vue';
import type { FormField } from '../../src/shared/api';
import type { LanesInputData } from '../../src/shared/ui';
import { useGame } from '../core/game';
import { uiText } from './text';

export interface LanesValue {
	lanes: { group: string; counts: Record<string, number> }[];
	extra: Record<string, number>;
}

const props = defineProps<{ field: FormField; values: Record<string, string | number | boolean>; modelValue?: LanesValue }>();
const emit = defineEmits<{ 'update:modelValue': [value: LanesValue] }>();
const game = useGame();
const data = computed(() => props.field.data as LanesInputData);
const pool = computed(() => data.value.pools[String(props.values[data.value.poolField] ?? '')] ?? {});
const available = (list: LanesInputData['options']) => list.filter((o) => pool.value[o.id]).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
const optionsOf = (group: string) => available(data.value.options.filter((o) => o.group === group));
const extraOptions = computed(() => available(data.value.options.filter((o) => !o.group)));

type Counts = Record<string, number | ''>;
const lanes = reactive<{ group: string; counts: Counts }[]>([]);
const extra = reactive<Counts>({});

/** Fresh lanes for this pool: the groups it has something of, taking turns; counts empty. */
function reset() {
	const present = data.value.groups.filter((g) => optionsOf(g.id).length).map((g) => g.id);
	const cycle = present.length ? present : data.value.groups.map((g) => g.id);
	lanes.splice(0, lanes.length, ...Array.from({ length: data.value.lanes }, (_, i) => ({ group: cycle[i % cycle.length], counts: {} })));
	for (const k of Object.keys(extra)) delete extra[k];
}
// Only when the pool or the data really change (troops sent, trained...): the form is re-sent on every
// state refresh, and a half-filled editor must survive that.
watch(() => [props.values[data.value.poolField], JSON.stringify(props.field.data)], reset, { immediate: true });

const count = (v: number | '' | undefined) => (typeof v === 'number' && v > 0 ? Math.floor(v) : 0);
/** How many of `option` are still free for lane `lane` (-1 = the extra box). */
const free = (option: string, lane: number) =>
	(pool.value[option] ?? 0) - lanes.reduce((sum, l, i) => sum + (i === lane ? 0 : count(l.counts[option])), 0);
const over = (option: string, lane: number, v: number | '' | undefined) => count(v) > 0 && count(v) > free(option, lane);
const total = computed(() => lanes.reduce((sum, l) => sum + Object.values(l.counts).reduce<number>((s, v) => s + count(v), 0), 0));
const extraTotal = computed(() => Object.values(extra).reduce<number>((s, v) => s + count(v), 0));

const clean = (c: Counts) => Object.fromEntries(Object.entries(c).flatMap(([u, v]) => (count(v) ? [[u, count(v)]] : [])));
watch(
	[lanes, extra],
	() => emit('update:modelValue', { lanes: lanes.map((l) => ({ group: l.group, counts: clean(l.counts) })), extra: clean(extra) }),
	{ deep: true, immediate: true },
);
</script>

<template>
	<fieldset class="lanes-input">
		<legend v-if="data.title">{{ uiText(game, data.title) }}</legend>
		<div v-for="(lane, i) in lanes" :key="i" class="lane">
			<div class="lane-head">
				<strong>{{ game.t(data.laneLabel.text, { 0: i + 1 }) }}</strong>
				<select v-model="lane.group" @change="lane.counts = {}">
					<option v-for="g in data.groups" :key="g.id" :value="g.id">{{ uiText(game, g.label) }}</option>
				</select>
			</div>
			<div v-if="optionsOf(lane.group).length" class="counts">
				<label v-for="o in optionsOf(lane.group)" :key="o.id" :class="{ over: over(o.id, i, lane.counts[o.id]) }">
					<small>{{ uiText(game, o.label) }}</small>
					<input
						v-model.number="lane.counts[o.id]"
						type="number"
						min="0"
						:max="Math.max(0, free(o.id, i))"
						:placeholder="game.t('at most {0}', { 0: Math.max(0, free(o.id, i)) })"
					/>
				</label>
			</div>
			<small v-else-if="data.emptyLane" class="muted">{{ uiText(game, data.emptyLane) }}</small>
		</div>
		<div v-if="data.extra && extraOptions.length" class="lane">
			<div class="lane-head">
				<strong>{{ uiText(game, data.extra.title) }}</strong>
				<small v-if="data.extra.note" class="muted">{{ uiText(game, data.extra.note) }}</small>
			</div>
			<div class="counts">
				<label v-for="o in extraOptions" :key="o.id" :class="{ over: over(o.id, -1, extra[o.id]) }">
					<small>{{ uiText(game, o.label) }}</small>
					<input
						v-model.number="extra[o.id]"
						type="number"
						min="0"
						:max="pool[o.id]"
						:placeholder="game.t('at most {0}', { 0: pool[o.id] })"
					/>
				</label>
			</div>
		</div>
		<small v-if="data.summary" class="muted">{{ game.t(data.summary.text, { 0: total, 1: extraTotal }) }}</small>
	</fieldset>
</template>

<style scoped>
.lanes-input {
	display: grid;
	gap: 8px;
	margin: 0;
	padding: 8px 10px 10px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
}

legend {
	padding: 0 4px;
	font-weight: 600;
}

.lane {
	display: grid;
	gap: 4px;
	padding-top: 6px;
	border-top: 1px solid var(--border);
}

.lane:first-of-type {
	border-top: none;
	padding-top: 0;
}

.lane-head {
	display: flex;
	gap: 8px;
	align-items: center;
}

.lane-head select {
	flex: 1;
	width: auto;
	padding: 2px 6px;
}

.counts {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(76px, 1fr));
	gap: 6px;
}

.counts label {
	display: grid;
	gap: 2px;
}

.counts input {
	padding: 4px 6px;
}

.counts .over input {
	border-color: var(--danger);
	color: var(--danger);
}
</style>
