<script setup lang="ts">
// Structured editor for a JSON-shaped config value: numbers, strings, booleans, objects
// (with add/remove for maps) and arrays (with add/remove rows). Emits a new value on change.
import { computed, ref, useId } from 'vue';
import { useGame } from '../../core/game';

defineOptions({ name: 'ValueEditor' });
/** `peers`: values at the same place elsewhere in the rule (other levels, kinds...), to suggest keys from. */
const props = defineProps<{ value: unknown; depth?: number; peers?: unknown[] }>();
const emit = defineEmits<{ update: [value: unknown] }>();
const game = useGame('gm-panel');
const depth = computed(() => props.depth ?? 0);

const kind = computed(() => {
	const v = props.value;
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'array';
	if (v !== null && typeof v === 'object') return 'object';
	return typeof v; // number | string | boolean
});
const entries = computed(() => Object.entries((props.value ?? {}) as Record<string, unknown>));
/** Maps whose values are all numbers (or empty) can gain and lose keys, e.g. { food: 100 }. */
const isNumberMap = computed(() => kind.value === 'object' && entries.value.every(([, v]) => typeof v === 'number'));
const newKey = ref('');
// Per instance: datalists with the same id would all show the first one's options.
const listId = `keys-${useId()}`;
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Content id lists a map may be keyed by, and their names. */
const meta = game.meta;
const pools: { id: string; name: string }[][] = [
	meta.resources ?? [],
	meta.buildings ?? [],
	meta.units ?? [],
	meta.settlementKinds ?? [],
	meta.terrains ?? [],
	meta.items ?? [],
	meta.techs ?? [],
	meta.realms ?? [],
	meta.battleFamilies ?? [],
	meta.heroes?.attributes ?? [],
	meta.heroes?.duties ?? [],
	meta.heroes?.venues ?? [],
	meta.equipment?.slots ?? [],
	meta.equipment?.rarities ?? [],
];
/**
 * What a new key may be: the content list every key seen here and in the peers belongs to (e.g. resources
 * for a cost, units for a garrison), else the keys the peers have (lanes 1-5 of other levels); resources
 * when there is nothing to go by.
 */
const keyOptions = computed(() => {
	const present = new Set(entries.value.map(([k]) => k));
	const seen = new Set([...present, ...(props.peers ?? []).filter(isObject).flatMap((p) => Object.keys(p))]);
	const pool = seen.size ? pools.find((list) => [...seen].every((k) => list.some((x) => x.id === k))) : (meta.resources ?? []);
	const ids = pool ? pool.map((x) => x.id) : [...seen].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
	return ids.filter((id) => !present.has(id));
});
/** Peers for a field: the same field of each peer, plus the other entries when this object is a map of alike values. */
const fieldPeers = (k: string) => {
	const own = entries.value.every(([, v]) => isObject(v)) ? entries.value.map(([, v]) => v) : [];
	return [...own, ...(props.peers ?? []).filter(isObject).map((p) => p[k])].filter((v) => v !== undefined);
};
/** Peers for array rows: every row here and in the peers' arrays. */
const rowPeers = computed(() => [...((props.value as unknown[]) ?? []), ...(props.peers ?? []).filter(Array.isArray).flat()]);

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
	emit('update', [...list, structuredClone([...list].reverse().find((x) => x !== null) ?? 0)]);
};
/** Planning tables may leave levels out (null): they grow from the nearest lower row. */
const holds = computed(() => kind.value === 'array' && (props.value as unknown[]).some((x) => x !== null && typeof x === 'object'));
const addEmpty = () => emit('update', [...(props.value as unknown[]), null]);
const fill = (i: number) =>
	setItem(
		i,
		structuredClone(
			(props.value as unknown[])
				.slice(0, i)
				.reverse()
				.find((x) => x !== null) ?? 0,
		),
	);
/** Content ids show as their names; field names have their own translations (`field:<name>`, gm-panel). */
// The first list wins a shared id (resource "gold" before the gold rarity).
const names = new Map(
	pools
		.flat()
		.reverse()
		.map((x) => [x.id, x.name]),
);
function label(k: string) {
	const name = names.get(k);
	if (name) return game.t(name);
	const field = game.t(`field:${k}`);
	return field === `field:${k}` ? game.t(k) : field;
}
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
	<span v-else-if="kind === 'null'" class="muted">{{ game.t('(grows from the level below)') }}</span>

	<div v-else-if="kind === 'object'" class="object" :class="{ nested: depth > 0 }">
		<div v-for="[k, v] in entries" :key="k" class="field" :class="{ inline: typeof v !== 'object' || v === null }">
			<span class="key">{{ label(k) }}</span>
			<ValueEditor :value="v" :depth="depth + 1" :peers="fieldPeers(k)" @update="setKey(k, $event)" />
			<button v-if="isNumberMap" type="button" class="link" :title="game.t('Remove')" @click="removeKey(k)">✕</button>
		</div>
		<form v-if="isNumberMap" class="add" @submit.prevent="addKey">
			<input v-model="newKey" :list="listId" :placeholder="game.t('add…')" />
			<datalist :id="listId">
				<option v-for="k in keyOptions" :key="k" :value="k">{{ label(k) }}</option>
			</datalist>
			<button type="submit" class="small secondary">+</button>
		</form>
		<small v-if="!entries.length && !isNumberMap" class="muted">{{ game.t('(empty)') }}</small>
	</div>

	<div v-else-if="kind === 'array'" class="array">
		<div v-for="(item, i) in value as unknown[]" :key="i" class="row">
			<span class="key">{{ i + 1 }}</span>
			<div class="cell">
				<ValueEditor :value="item" :depth="depth + 1" :peers="rowPeers" @update="setItem(i, $event)" />
				<button v-if="item === null" type="button" class="small secondary" @click="fill(i)">{{ game.t('Fill in') }}</button>
			</div>
			<button type="button" class="link" :title="game.t('Remove')" @click="removeItem(i)">✕</button>
		</div>
		<div class="add">
			<button type="button" class="small secondary" @click="addItem">+ {{ game.t('row') }}</button>
			<button v-if="holds" type="button" class="small secondary" @click="addEmpty">+ {{ game.t('empty row') }}</button>
		</div>
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

.cell {
	display: flex;
	gap: 8px;
	align-items: center;
}

.check {
	width: auto;
	justify-self: start;
}

input[type='number'] {
	max-width: 180px;
}
</style>
