<script setup lang="ts">
import { pluginName as nameOf } from './names';
import { errorText } from '../../core/api';
import { computed, ref, shallowRef, watch } from 'vue';
import type { ReportInfo, ReportRows } from '../../../src/shared/api';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';
import { useResource } from './useResource';
import ValueEditor from './ValueEditor.vue';

const game = useGame('gm-panel');
const { data: reports, error } = useResource<ReportInfo[]>(() => '/api/gm/reports');
const selected = ref('');
const params = shallowRef<unknown>({});
const rows = shallowRef<ReportRows | null>(null);
const busy = ref(false);

const current = computed(() => reports.value?.find((r) => r.id === selected.value));
const groups = computed(() => {
	const out = new Map<string, ReportInfo[]>();
	for (const r of reports.value ?? []) out.set(r.owner, [...(out.get(r.owner) ?? []), r]);
	return [...out.entries()];
});
const columns = computed(() => [...new Set((rows.value ?? []).flatMap((r) => Object.keys(r)))]);
const pluginName = (id: string) => nameOf(game, id);
const names = new Map(
	[...(game.meta.resources ?? []), ...(game.meta.buildings ?? []), ...(game.meta.units ?? []), ...(game.meta.settlementKinds ?? [])].map(
		(x) => [x.id, x.name],
	),
);

watch(reports, (list) => (selected.value ||= list?.[0]?.id ?? ''));
watch(current, (r) => {
	params.value = structuredClone(r?.example ?? {});
	rows.value = null;
});

const cell = (v: unknown) =>
	typeof v === 'number'
		? formatNumber(v, { decimals: Number.isInteger(v) ? 0 : 2 })
		: v === null || v === undefined
			? ''
			: game.t(names.get(String(v)) ?? String(v));

async function run() {
	busy.value = true;
	try {
		rows.value = await game.request<ReportRows>(`/api/gm/reports/${encodeURIComponent(selected.value)}`, {
			method: 'POST',
			body: { params: params.value },
		});
	} catch (err) {
		game.toast(errorText(err));
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<p v-if="error" class="error">{{ game.t(error) }}</p>
	<template v-else-if="reports">
		<label>
			{{ game.t('Report') }}
			<select v-model="selected">
				<optgroup v-for="[owner, list] in groups" :key="owner" :label="pluginName(owner)">
					<option v-for="r in list" :key="r.id" :value="r.id">{{ game.t(r.description) }}</option>
				</optgroup>
			</select>
		</label>
		<template v-if="current">
			<small class="muted"
				><code>{{ current.id }}</code></small
			>
			<div class="params">
				<span class="muted">{{ game.t('Parameters') }}</span>
				<ValueEditor :value="params" :rule="current && { key: current.id, owner: current.owner }" @update="params = $event" />
			</div>
			<button type="button" class="small" :disabled="busy" @click="run">{{ game.t('Run') }}</button>
		</template>
		<p v-if="rows?.length === 0" class="muted">{{ game.t('No rows.') }}</p>
		<div v-else-if="rows" class="table-wrap">
			<table>
				<thead>
					<tr>
						<th v-for="c in columns" :key="c">{{ game.t(c) }}</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="(r, i) in rows" :key="i">
						<td v-for="c in columns" :key="c">{{ cell(r[c]) }}</td>
					</tr>
				</tbody>
			</table>
		</div>
	</template>
</template>

<style scoped>
label {
	max-width: 520px;
}

.params {
	display: grid;
	gap: 6px;
	margin: 8px 0;
}

.table-wrap {
	overflow-x: auto;
	margin-top: 12px;
}

td {
	font-variant-numeric: tabular-nums;
}
</style>
