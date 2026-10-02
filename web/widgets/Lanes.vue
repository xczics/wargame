<script setup lang="ts">
// Generic widget "ui.lanes": a side-by-side account row by row (e.g. a battle lane by lane): a summary,
// a table (row labels coloured won / lost, each cell a few status lines), notes. Given its data
// directly (inside a report) or by a view.
import { computed } from 'vue';
import type { LanesData } from '../../src/shared/ui';
import { useGame } from '../core/game';
import Line from './Line.vue';
import { uiText } from './text';

const props = defineProps<{ view?: string; data?: LanesData }>();
const game = useGame('widgets');
const lanes = computed(() => props.data ?? ((props.view ? game.state.value?.views[props.view] : null) as LanesData | null));
</script>

<template>
	<div v-if="lanes" class="lanes">
		<Line v-for="(l, i) in lanes.summary ?? []" :key="`s${i}`" :line="l" />
		<table>
			<thead>
				<tr>
					<th v-for="(c, i) in lanes.columns" :key="i">{{ uiText(game, c) }}</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="(row, i) in lanes.rows" :key="i" :class="row.tone">
					<th>{{ uiText(game, row.label) }}</th>
					<td v-for="(cell, k) in row.cells" :key="k">
						<Line v-for="(l, j) in cell" :key="j" :line="l" />
					</td>
				</tr>
			</tbody>
		</table>
		<Line v-for="(l, i) in lanes.notes ?? []" :key="`n${i}`" :line="l" />
	</div>
</template>

<style scoped>
.lanes {
	display: grid;
	gap: 4px;
	margin: 4px 0;
}

table {
	border-collapse: collapse;
	width: 100%;
	font-size: 0.9em;
}

th,
td {
	text-align: left;
	padding: 4px 6px;
	border-bottom: 1px solid var(--border);
	vertical-align: top;
}

td :deep(small) {
	display: block;
}

tr.good th {
	color: var(--info);
}

tr.bad th {
	color: var(--danger);
}
</style>
