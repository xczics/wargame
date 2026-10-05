<script setup lang="ts">
// Generic widget "ui.table": a small table (the first cell of each row is its label); cells with
// details show them on hover.
import { computed } from 'vue';
import type { TableData } from '../../src/shared/ui';
import { useGame } from '../core/game';
import { resolveCell } from '../../src/shared/statics';
import Line from './Line.vue';
import { hintText, uiText } from './text';

const props = defineProps<{ view: string }>();
const game = useGame('widgets');
// Cells may show the client's own counters (e.g. stock counted on): worked out on every tick.
const data = computed(() => {
	const d = (game.state.value?.views[props.view] ?? null) as TableData | null;
	return d && { ...d, rows: d.rows.map((r) => ({ ...r, cells: r.cells.map((c) => resolveCell(c, (k) => game.counter(k))) })) };
});
</script>

<template>
	<section v-if="data && data.rows.length" class="card table">
		<h2 v-if="data.title">{{ uiText(game, data.title) }}</h2>
		<div class="scroll">
			<table>
				<thead>
					<tr>
						<th v-for="(c, i) in data.columns" :key="i">{{ uiText(game, c) }}</th>
					</tr>
				</thead>
				<tbody>
					<tr v-for="r in data.rows" :key="r.id">
						<component
							:is="i ? 'td' : 'th'"
							v-for="(c, i) in r.cells"
							:key="i"
							:scope="i ? undefined : 'row'"
							:class="[c.tone, { hinted: c.hint?.length }]"
							:title="hintText(game, c)"
							>{{ uiText(game, c.text) }}</component
						>
					</tr>
				</tbody>
			</table>
		</div>
		<Line v-for="(l, i) in data.lines ?? []" :key="i" :line="l" />
	</section>
</template>

<style scoped>
.table {
	display: grid;
	gap: 8px;
}

.table h2 {
	margin: 0;
}

/* A narrow column scrolls the table rather than the page. */
.scroll {
	overflow-x: auto;
}

table {
	border-collapse: collapse;
	width: 100%;
	font-variant-numeric: tabular-nums;
	font-size: 0.92em;
}

th,
td {
	padding: 4px 6px;
	border-bottom: 1px solid var(--border);
	text-align: right;
	white-space: nowrap;
}

thead th {
	color: var(--muted);
	font-weight: 500;
}

tr > :first-child {
	text-align: left;
}

.muted {
	color: var(--muted);
}

.warn {
	color: var(--danger);
}

.info {
	color: var(--info);
}

.hinted {
	text-decoration: underline dotted;
	text-underline-offset: 3px;
	cursor: help;
}
</style>
