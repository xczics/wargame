<script setup lang="ts">
// Generic widget "ui.cells": a small board of cells (e.g. a settlement's districts where they lie).
// A selectable cell shares its id with the widgets of the same `filter` (and closes an open entry,
// which belongs to the old selection); a cell with an action runs it (e.g. build an outer city there).
import { computed } from 'vue';
import type { CellsData } from '../../src/shared/ui';
import { useGame } from '../core/game';
import Cell from './Cell.vue';
import { chosen } from './state';
import { uiText } from './text';

const props = defineProps<{ view: string; filter?: string }>();
const game = useGame('widgets');
const data = computed(() => (game.state.value?.views[props.view] ?? null) as CellsData | null);
const selected = computed(() => {
	const ids = (data.value?.cells ?? []).flatMap((c) => (c?.selectable ? [c.id] : []));
	const pick = props.filter ? chosen[props.filter] : null;
	return pick && ids.includes(pick) ? pick : (data.value?.defaultSelected ?? null);
});
function pick(id: string) {
	if (!props.filter) return;
	chosen[props.filter] = id;
	if (game.entry.value) game.openEntry(null);
}
</script>

<template>
	<section v-if="data" class="card">
		<h2 v-if="data.title">{{ uiText(game, data.title) }}</h2>
		<div class="grid" :style="{ gridTemplateColumns: `repeat(${data.columns}, 1fr)` }">
			<Cell v-for="(c, i) in data.cells" :key="c?.id ?? `empty${i}`" :cell="c" :active="!!c && c.id === selected" @pick="pick" />
		</div>
	</section>
</template>

<style scoped>
.grid {
	display: grid;
	gap: 4px;
	max-width: 280px;
}
</style>
