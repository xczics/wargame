<script setup lang="ts">
// The attack formation editor (form widget "battle.formation"): each lane gets a family and
// a count per tier; support units march outside the lanes. Every box shows how many are
// still free: the origin's garrison minus what the other lanes already hold.
import { computed, reactive, watch } from 'vue';
import type { FormField, FormationWidgetData } from '../../../src/shared/api';
import { useGame } from '../../core/game';

export interface FormationValue {
	lanes: { family: string; units: Record<string, number> }[];
	/** Support units, outside the lanes. */
	aux: Record<string, number>;
}

const props = defineProps<{ field: FormField; values: Record<string, string | number | boolean>; modelValue?: FormationValue }>();
const emit = defineEmits<{ 'update:modelValue': [value: FormationValue] }>();
const game = useGame();
const data = computed(() => props.field.data as FormationWidgetData);
const garrison = computed(() => data.value.garrisons[String(props.values.from ?? '')] ?? {});
const available = (list: FormationWidgetData['units']) => list.filter((u) => garrison.value[u.id]).sort((a, b) => a.tier - b.tier);
const tiersOf = (family: string) => available(data.value.units.filter((u) => u.family === family));
// Tiers are shown by name ("Militia (Infantry)"), never as a number.
const unitNames = new Map((game.meta.units ?? []).map((u) => [u.id, u.name]));
const unitName = (id: string) => game.t(unitNames.get(id) ?? id);
const support = computed(() => available(data.value.units.filter((u) => !u.family)));

type Counts = Record<string, number | ''>;
const lanes = reactive<{ family: string; units: Counts }[]>([]);
const aux = reactive<Counts>({});

/** Fresh lanes for the origin: the families it has troops of, taking turns; counts empty. */
function reset() {
	const present = data.value.families.filter((f) => tiersOf(f.id).length).map((f) => f.id);
	const cycle = present.length ? present : data.value.families.map((f) => f.id);
	lanes.splice(0, lanes.length, ...Array.from({ length: data.value.lanes }, (_, i) => ({ family: cycle[i % cycle.length], units: {} })));
	for (const k of Object.keys(aux)) delete aux[k];
}
watch(() => [props.values.from, props.field], reset, { immediate: true });

const count = (v: number | '' | undefined) => (typeof v === 'number' && v > 0 ? Math.floor(v) : 0);
/** How many of `unit` are still free for lane `lane` (-1 = the support box). */
const free = (unit: string, lane: number) =>
	(garrison.value[unit] ?? 0) - lanes.reduce((sum, l, i) => sum + (i === lane ? 0 : count(l.units[unit])), 0);
const over = (unit: string, lane: number, v: number | '' | undefined) => count(v) > 0 && count(v) > free(unit, lane);
const total = computed(() => lanes.reduce((sum, l) => sum + Object.values(l.units).reduce<number>((s, v) => s + count(v), 0), 0));
const auxTotal = computed(() => Object.values(aux).reduce<number>((s, v) => s + count(v), 0));

const clean = (c: Counts) => Object.fromEntries(Object.entries(c).flatMap(([u, v]) => (count(v) ? [[u, count(v)]] : [])));
watch(
	[lanes, aux],
	() => emit('update:modelValue', { lanes: lanes.map((l) => ({ family: l.family, units: clean(l.units) })), aux: clean(aux) }),
	{ deep: true, immediate: true },
);
const familyName = (id: string) => {
	const f = data.value.families.find((x) => x.id === id);
	return `${f?.icon ?? ''} ${game.t(f?.name ?? id)}`;
};
</script>

<template>
	<fieldset class="formation">
		<legend>{{ game.t('Formation') }}</legend>
		<div v-for="(lane, i) in lanes" :key="i" class="lane">
			<div class="lane-head">
				<strong>{{ game.t('Lane {n}', { n: i + 1 }) }}</strong>
				<select v-model="lane.family" @change="lane.units = {}">
					<option v-for="f in data.families" :key="f.id" :value="f.id">{{ familyName(f.id) }}</option>
				</select>
			</div>
			<div v-if="tiersOf(lane.family).length" class="counts">
				<label v-for="u in tiersOf(lane.family)" :key="u.id" :class="{ over: over(u.id, i, lane.units[u.id]) }">
					<small>{{ unitName(u.id) }}</small>
					<input
						v-model.number="lane.units[u.id]"
						type="number"
						min="0"
						:max="Math.max(0, free(u.id, i))"
						:placeholder="game.t('at most {n}', { n: Math.max(0, free(u.id, i)) })"
					/>
				</label>
			</div>
			<small v-else class="muted">{{ game.t('No such troops here: this lane stays empty.') }}</small>
		</div>
		<div v-if="support.length" class="lane">
			<div class="lane-head">
				<strong>{{ game.t('Support units') }}</strong>
				<small class="muted">{{ game.t('march along outside the lanes') }}</small>
			</div>
			<div class="counts">
				<label v-for="u in support" :key="u.id" :class="{ over: over(u.id, -1, aux[u.id]) }">
					<small>{{ game.t(u.name) }}</small>
					<input
						v-model.number="aux[u.id]"
						type="number"
						min="0"
						:max="garrison[u.id]"
						:placeholder="game.t('at most {n}', { n: garrison[u.id] })"
					/>
				</label>
			</div>
		</div>
		<small class="muted">{{ game.t('{n} in the lanes, {m} support units', { n: total, m: auxTotal }) }}</small>
	</fieldset>
</template>

<style scoped>
.formation {
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
