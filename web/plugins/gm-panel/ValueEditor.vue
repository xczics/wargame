<script setup lang="ts">
// Structured editor for a JSON-shaped config value: numbers, strings, booleans, objects
// (with add/remove for maps) and arrays (with add/remove rows). Emits a new value on change.
import { computed, ref, useId } from 'vue';
import type { UiText } from '../../../src/shared/ui';
import { useGame } from '../../core/game';

defineOptions({ name: 'ValueEditor' });
/** `peers`: values at the same place elsewhere in the rule (other levels, kinds...), to suggest keys from. */
// `rule`: whose value it is: field names are its owner's texts ("<owner>.field:<name>", or "field:<rule>.<name>" for one
// that means something else in this rule), in the owner's data/i18n.csv.
const props = defineProps<{ value: unknown; depth?: number; peers?: unknown[]; rule?: { key: string; owner: string } }>();
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
// A name is a key or a text with values (e.g. a realm's pool: the realm's name and the task number).
const pools: { id: string; name: string | UiText }[][] = [
	meta.resources ?? [],
	meta.buildings ?? [],
	meta.units ?? [],
	meta.settlementKinds ?? [],
	meta.terrains ?? [],
	meta.items ?? [],
	meta.techs ?? [],
	meta.realms ?? [],
	meta.battleFamilies ?? [],
	meta.shopOffers ?? [],
	meta.realmPools ?? [],
	meta.siegeItems ?? [],
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
/** Content ids show as their names; field names are the rule owner's texts. */
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
	const r = props.rule;
	if (r) {
		const name = r.key.startsWith(`${r.owner}.`) ? r.key.slice(r.owner.length + 1) : r.key;
		const key = [`${r.owner}.field:${name}.${k}`, `${r.owner}.field:${k}`].find((x) => game.hasText(x));
		if (key) return game.t(key);
	}
	return k;
}

/*
 * ----- a long map at the top (e.g. every building): picked from a drop-down, nothing shown until one is (user
 * 2026-10-05: "筛选默认不显示任何。只有往筛选框里填东西了，才显示。然后筛选框要加下拉框，不要手动填名称") -----
 */
const picked = ref('');
// (Rows of numbers show as a table instead, however many: one row each is short enough.)
const filterable = computed(
	() =>
		depth.value === 0 &&
		kind.value === 'object' &&
		entries.value.length > 8 &&
		!(entries.value.every(([, v]) => isObject(v)) && tableColumns(entries.value.map(([, v]) => v))),
);
const choices = computed(() => entries.value.map(([k]) => ({ key: k, label: label(k) })).sort((a, b) => a.label.localeCompare(b.label)));
const shown = computed(() => (filterable.value ? entries.value.filter(([k]) => k === picked.value) : entries.value));

/*
 * ----- rows of numbers (e.g. a building's levels): a table, a level a row and a column per number, those inside a
 * map (a cost) one per key (user 2026-10-05: "等级-消耗量按表格显示"). Other arrays are edited row by row. -----
 */
type Column = { key: string; sub?: string; bool?: boolean; text?: boolean };
/**
 * The columns of rows of numbers: a number or a switch is a column; a map of numbers inside (e.g. a cost, the men of
 * each tier) a column per key. Null when a row holds anything else (then it is edited as it is).
 */
function tableColumns(rows: unknown[]): Column[] | null {
	if (!rows.some(isObject) || rows.some((r) => r !== null && !isObject(r))) return null;
	// Top-level keys in the order first seen; a map's keys together after it, numbers in order (tier 1, 2, 3...).
	const order: string[] = [];
	const kinds = new Map<string, 'number' | 'bool' | 'text' | 'map'>();
	const subs = new Map<string, Set<string>>();
	for (const r of rows.filter(isObject))
		for (const [k, v] of Object.entries(r)) {
			const kind =
				typeof v === 'number'
					? 'number'
					: typeof v === 'boolean'
						? 'bool'
						: typeof v === 'string'
							? 'text'
							: isObject(v) && Object.values(v).every((x) => typeof x === 'number')
								? 'map'
								: null;
			if (!kind) return null;
			if (!kinds.has(k)) order.push(k) && kinds.set(k, kind);
			if (kind === 'map') for (const sub of Object.keys(v as object)) (subs.get(k) ?? subs.set(k, new Set()).get(k)!).add(sub);
		}
	const byNumber = (a: string, b: string) => (Number.isNaN(Number(a)) || Number.isNaN(Number(b)) ? 0 : Number(a) - Number(b));
	return order.flatMap((k): Column[] => {
		const kind = kinds.get(k)!;
		if (kind !== 'map') return [{ key: k, ...(kind === 'bool' ? { bool: true } : kind === 'text' ? { text: true } : {}) }];
		// A map with no keys in any row still shows (an empty column), so a key can be added to it.
		const list = [...(subs.get(k) ?? [])].sort(byNumber);
		return list.length ? list.map((sub) => ({ key: k, sub })) : [{ key: k, sub: '' }];
	});
}
const columns = computed(() => (kind.value === 'array' ? tableColumns(props.value as unknown[]) : null));
const cellOf = (row: unknown, c: Column) => {
	if (!isObject(row)) return undefined;
	const v = row[c.key];
	return c.sub === undefined ? v : isObject(v) ? v[c.sub] : undefined;
};
/** A row with one cell changed (an empty number in a map: none of it there, e.g. a cost without that resource). */
function withCell(row: Record<string, unknown>, c: Column, raw: string | boolean) {
	const next = structuredClone(row);
	if (c.sub === undefined) next[c.key] = typeof raw === 'boolean' || c.text ? raw : raw === '' ? 0 : Number(raw);
	else {
		const map = { ...((next[c.key] as Record<string, number> | undefined) ?? {}) };
		if (raw === '') delete map[c.sub];
		else map[c.sub] = Number(raw);
		next[c.key] = map;
	}
	return next;
}
const setCell = (i: number, c: Column, raw: string | boolean) =>
	setItem(i, withCell((props.value as unknown[])[i] as Record<string, unknown>, c, raw));
/** Add a key to a map column group in every row (rows of an array, or entries of a map). */
function withColumn(rows: unknown[], group: string, k: string) {
	return rows.map((r) => (isObject(r) ? { ...r, [group]: { ...((r[group] as object) ?? {}), [k]: 0 } } : r));
}
const newColumn = ref<Record<string, string>>({});
function addColumn(group: string) {
	const k = (newColumn.value[group] ?? '').trim();
	if (!k) return;
	if (kind.value === 'array') emit('update', withColumn(props.value as unknown[], group, k));
	else {
		const keys = entries.value.map(([key]) => key);
		const rows = withColumn(
			entries.value.map(([, v]) => v),
			group,
			k,
		);
		emit('update', Object.fromEntries(keys.map((key, i) => [key, rows[i]])));
	}
	newColumn.value = { ...newColumn.value, [group]: '' };
}
/** What a group may get as a new column: the content list its keys belong to (resources for a cost, tiers for men). */
const columnOptions = (group: string, cols: Column[]) => {
	const present = cols.filter((c) => c.key === group && c.sub).map((c) => c.sub!);
	const pool = present.length ? pools.find((list) => present.every((k) => list.some((x) => x.id === k))) : (meta.resources ?? []);
	if (pool) return pool.map((x) => x.id).filter((id) => !present.includes(id));
	// Numbered keys (tiers, lanes): the next number.
	const nums = present.map(Number).filter(Number.isInteger);
	return nums.length === present.length && nums.length ? [String(Math.max(...nums) + 1)] : [];
};

/*
 * ----- a map of alike rows of numbers (cost shares by family, each NPC level by kind...): the same table, an entry
 * a row (user 2026-10-05: "这个也要换成表格显示"；"NPC城池的GM也要用表格显示。要不然一级一级过去太长了"). -----
 */
const recordColumns = computed(() =>
	kind.value === 'object' && !filterable.value && entries.value.length >= 2 && entries.value.every(([, v]) => isObject(v))
		? tableColumns(entries.value.map(([, v]) => v))
		: null,
);
const setRecordCell = (k: string, c: Column, raw: string | boolean) =>
	setKey(k, withCell((props.value as Record<string, Record<string, unknown>>)[k], c, raw));
/** A column's heading: a content name as it is (a resource), else the group and the key ("lane 1"). */
/** A column's heading: its field, or for a key inside a map the map's field and the key ("cost stone", "lane 1"). */
const heading = (c: Column) => (c.sub ? `${label(c.key)} ${label(c.sub)}` : label(c.key));
const groupsOf = (cols: Column[]) => [...new Set(cols.filter((c) => c.sub !== undefined).map((c) => c.key))];
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

	<div v-else-if="kind === 'object' && recordColumns" class="array">
		<div class="table-wrap">
			<table class="levels">
				<thead>
					<tr>
						<th></th>
						<th v-for="c in recordColumns" :key="`${c.key}.${c.sub ?? ''}`" :title="c.sub ? label(c.key) : undefined">
							{{ heading(c) }}
						</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="[k, rec] in entries" :key="k">
						<th scope="row">{{ label(k) }}</th>
						<td v-for="c in recordColumns" :key="`${c.key}.${c.sub ?? ''}`">
							<input
								v-if="c.bool"
								type="checkbox"
								class="check"
								:checked="cellOf(rec, c) === true"
								@change="setRecordCell(k, c, ($event.target as HTMLInputElement).checked)"
							/>
							<input
								v-else-if="c.text"
								type="text"
								class="text"
								:value="cellOf(rec, c) ?? ''"
								@change="setRecordCell(k, c, ($event.target as HTMLInputElement).value)"
							/>
							<input
								v-else-if="c.sub !== ''"
								type="number"
								step="any"
								:value="cellOf(rec, c) ?? ''"
								@change="setRecordCell(k, c, ($event.target as HTMLInputElement).value)"
							/>
						</td>
					</tr>
				</tbody>
			</table>
		</div>
		<div class="add">
			<form v-for="g in groupsOf(recordColumns)" :key="g" class="add" @submit.prevent="addColumn(g)">
				<input v-model="newColumn[g]" :list="`${listId}-${g}`" :placeholder="`${label(g)}: ${game.t('add…')}`" />
				<datalist :id="`${listId}-${g}`">
					<option v-for="k in columnOptions(g, recordColumns)" :key="k" :value="k">{{ label(k) }}</option>
				</datalist>
				<button type="submit" class="small secondary">+</button>
			</form>
		</div>
	</div>

	<div v-else-if="kind === 'object'" class="object" :class="{ nested: depth > 0 }">
		<select v-if="filterable" v-model="picked" class="filter">
			<option value="">{{ game.t('Choose one to edit…') }}</option>
			<option v-for="c in choices" :key="c.key" :value="c.key">{{ c.label }}</option>
		</select>
		<div v-for="[k, v] in shown" :key="k" class="field" :class="{ inline: typeof v !== 'object' || v === null }">
			<span class="key">{{ label(k) }}</span>
			<ValueEditor :value="v" :depth="depth + 1" :peers="fieldPeers(k)" :rule="rule" @update="setKey(k, $event)" />
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

	<div v-else-if="kind === 'array' && columns" class="array">
		<div class="table-wrap">
			<table class="levels">
				<thead>
					<tr>
						<th></th>
						<th v-for="c in columns" :key="`${c.key}.${c.sub ?? ''}`" :title="c.sub ? label(c.key) : undefined">
							{{ heading(c) }}
						</th>
						<th></th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="(item, i) in value as unknown[]" :key="i">
						<th scope="row">{{ i + 1 }}</th>
						<template v-if="item === null">
							<td :colspan="columns.length" class="muted">
								{{ game.t('(grows from the level below)') }}
								<button type="button" class="small secondary" @click="fill(i)">{{ game.t('Fill in') }}</button>
							</td>
						</template>
						<template v-else>
							<td v-for="c in columns" :key="`${c.key}.${c.sub ?? ''}`">
								<input
									v-if="c.bool"
									type="checkbox"
									class="check"
									:checked="cellOf(item, c) === true"
									@change="setCell(i, c, ($event.target as HTMLInputElement).checked)"
								/>
								<input
									v-else-if="c.text"
									type="text"
									class="text"
									:value="cellOf(item, c) ?? ''"
									@change="setCell(i, c, ($event.target as HTMLInputElement).value)"
								/>
								<input
									v-else-if="c.sub !== ''"
									type="number"
									step="any"
									:value="cellOf(item, c) ?? ''"
									@change="setCell(i, c, ($event.target as HTMLInputElement).value)"
								/>
							</td>
						</template>
						<td><button type="button" class="link" :title="game.t('Remove')" @click="removeItem(i)">✕</button></td>
					</tr>
				</tbody>
			</table>
		</div>
		<div class="add">
			<button type="button" class="small secondary" @click="addItem">+ {{ game.t('row') }}</button>
			<button type="button" class="small secondary" @click="addEmpty">+ {{ game.t('empty row') }}</button>
			<form v-for="g in groupsOf(columns)" :key="g" class="add" @submit.prevent="addColumn(g)">
				<input v-model="newColumn[g]" :list="`${listId}-${g}`" :placeholder="`${label(g)}: ${game.t('add…')}`" />
				<datalist :id="`${listId}-${g}`">
					<option v-for="k in columnOptions(g, columns)" :key="k" :value="k">{{ label(k) }}</option>
				</datalist>
				<button type="submit" class="small secondary">+</button>
			</form>
		</div>
	</div>

	<div v-else-if="kind === 'array'" class="array">
		<div v-for="(item, i) in value as unknown[]" :key="i" class="row">
			<span class="key">{{ i + 1 }}</span>
			<div class="cell">
				<ValueEditor :value="item" :depth="depth + 1" :peers="rowPeers" :rule="rule" @update="setItem(i, $event)" />
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

.filter {
	max-width: 280px;
}

.table-wrap {
	overflow-x: auto;
}

.levels {
	border-collapse: collapse;
}

.levels th,
.levels td {
	padding: 2px 4px;
	text-align: left;
	font-size: 0.85em;
}

.levels thead th {
	color: var(--muted);
	font-weight: normal;
	white-space: nowrap;
}

.levels input.text {
	width: 140px;
	padding: 2px 6px;
}

.levels input[type='number'] {
	width: 90px;
	padding: 2px 6px;
}
</style>
