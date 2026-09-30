<script setup lang="ts">
// Structured editor for a JSON-shaped config value: numbers, strings, booleans, objects
// (with add/remove for maps) and arrays (with add/remove rows). Emits a new value on change.
import { computed, ref } from 'vue';
import { useGame } from '../../core/game';

defineOptions({ name: 'ValueEditor' });
const props = defineProps<{ value: unknown; depth?: number }>();
const emit = defineEmits<{ update: [value: unknown] }>();
const game = useGame();
const depth = computed(() => props.depth ?? 0);

const kind = computed(() => {
	const v = props.value;
	if (Array.isArray(v)) return 'array';
	if (v !== null && typeof v === 'object') return 'object';
	return typeof v; // number | string | boolean
});
const entries = computed(() => Object.entries((props.value ?? {}) as Record<string, unknown>));
/** Maps whose values are all numbers (or empty) can gain and lose keys, e.g. { food: 100 }. */
const isNumberMap = computed(() => kind.value === 'object' && entries.value.every(([, v]) => typeof v === 'number'));
const newKey = ref('');
const keyOptions = computed(() => {
	const present = new Set(entries.value.map(([k]) => k));
	return (game.meta.resources ?? []).map((r) => r.id).filter((id) => !present.has(id));
});

const setKey = (k: string, v: unknown) => emit('update', { ...(props.value as Record<string, unknown>), [k]: v });
function removeKey(k: string) {
	const next = { ...(props.value as Record<string, unknown>) };
	delete next[k];
	emit('update', next);
}
function addKey() {
	const k = newKey.value.trim();
	if (!k) return;
	setKey(k, 0);
	newKey.value = '';
}
const setItem = (i: number, v: unknown) =>
	emit(
		'update',
		(props.value as unknown[]).map((x, j) => (j === i ? v : x)),
	);
const removeItem = (i: number) =>
	emit(
		'update',
		(props.value as unknown[]).filter((_, j) => j !== i),
	);
// A new row copies the last one, which is the natural starting point for tables like building levels.
const addItem = () => {
	const list = props.value as unknown[];
	emit('update', [...list, structuredClone(list.at(-1) ?? 0)]);
};
/** Content ids (resources, buildings, units, settlement kinds) show as their names; other keys are translated as is. */
const names = new Map(
	[...(game.meta.resources ?? []), ...(game.meta.buildings ?? []), ...(game.meta.units ?? []), ...(game.meta.settlementKinds ?? [])].map(
		(x) => [x.id, x.name],
	),
);
const label = (k: string) => game.t(names.get(k) ?? k);
</script>

<template>
	<input
		v-if="kind === 'number'"
		type="number"
		step="any"
		:value="value"
		@input="emit('update', Number(($event.target as HTMLInputElement).value))"
	/>
	<input
		v-else-if="kind === 'boolean'"
		type="checkbox"
		class="check"
		:checked="value as boolean"
		@change="emit('update', ($event.target as HTMLInputElement).checked)"
	/>
	<input v-else-if="kind === 'string'" type="text" :value="value" @input="emit('update', ($event.target as HTMLInputElement).value)" />

	<div v-else-if="kind === 'object'" class="object" :class="{ nested: depth > 0 }">
		<div v-for="[k, v] in entries" :key="k" class="field" :class="{ inline: typeof v !== 'object' || v === null }">
			<span class="key">{{ label(k) }}</span>
			<ValueEditor :value="v" :depth="depth + 1" @update="setKey(k, $event)" />
			<button v-if="isNumberMap" type="button" class="link" :title="game.t('Remove')" @click="removeKey(k)">✕</button>
		</div>
		<form v-if="isNumberMap" class="add" @submit.prevent="addKey">
			<input v-model="newKey" :list="`keys-${depth}`" :placeholder="game.t('add…')" />
			<datalist :id="`keys-${depth}`">
				<option v-for="k in keyOptions" :key="k" :value="k">{{ label(k) }}</option>
			</datalist>
			<button type="submit" class="small secondary">+</button>
		</form>
		<small v-if="!entries.length && !isNumberMap" class="muted">{{ game.t('(empty)') }}</small>
	</div>

	<div v-else-if="kind === 'array'" class="array">
		<div v-for="(item, i) in value as unknown[]" :key="i" class="row">
			<span class="key">{{ i + 1 }}</span>
			<ValueEditor :value="item" :depth="depth + 1" @update="setItem(i, $event)" />
			<button type="button" class="link" :title="game.t('Remove')" @click="removeItem(i)">✕</button>
		</div>
		<button type="button" class="small secondary" @click="addItem">+ {{ game.t('row') }}</button>
	</div>
</template>

<style scoped>
.object,
.array {
	display: grid;
	gap: 6px;
}

.nested {
	padding-left: 10px;
	border-left: 2px solid var(--border);
}

.field,
.row {
	display: grid;
	gap: 4px;
}

.field.inline,
.row {
	grid-template-columns: minmax(80px, 140px) 1fr auto;
	align-items: center;
	gap: 8px;
}

.row {
	grid-template-columns: 24px 1fr auto;
	align-items: start;
}

.key {
	font-size: 0.85em;
	color: var(--muted);
}

.add {
	display: flex;
	gap: 6px;
	max-width: 280px;
}

.check {
	width: auto;
	justify-self: start;
}

input[type='number'] {
	max-width: 180px;
}
</style>
