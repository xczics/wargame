<script setup lang="ts">
// Generic widget "ui.filters": a heading, summary lines, one button per group of a cards view, a note.
// The choice is shared with the "ui.cards" of the same \`filter\`.
import { computed } from 'vue';
import { useGame } from '../core/game';
import { useCards } from './statics';
import { chosen } from './state';
import { uiText } from './text';

// `layout: 'row'`: the buttons side by side (e.g. above cards in the right column) instead of one per line.
const props = defineProps<{ view: string; filter: string; layout?: 'row' }>();
const game = useGame('widgets');
const data = useCards(game, () => props.view);
const count = (group: string) => (data.value?.cards ?? []).filter((c) => c.group === group).length;
const pick = (group: string | null) => (chosen[props.filter] = group);
// With a default group there is no "All": one group shows at a time (the default until one is picked).
const active = computed(() => {
	const c = chosen[props.filter] ?? null;
	if (!data.value?.defaultGroup) return c;
	return c !== null && data.value.groups?.some((g) => g.id === c) ? c : data.value.defaultGroup;
});
</script>

<template>
	<section v-if="data" class="card">
		<h2 v-if="data.title">{{ uiText(game, data.title) }}</h2>
		<p v-for="(s, i) in data.summary ?? []" :key="i" class="summary">{{ uiText(game, s) }}</p>
		<div v-if="data.groups?.length" class="groups" :class="layout">
			<button v-if="!data.defaultGroup" type="button" class="small" :class="{ secondary: active !== null }" @click="pick(null)">
				{{ game.t('All') }} ({{ data.cards.length }})
			</button>
			<button v-for="g in data.groups" :key="g.id" type="button" class="small" :class="{ secondary: active !== g.id }" @click="pick(g.id)">
				{{ uiText(game, g.label) }} ({{ count(g.id) }})
			</button>
		</div>
		<small v-if="data.note" class="muted">{{ uiText(game, data.note) }}</small>
	</section>
</template>

<style scoped>
.summary {
	margin: 0 0 8px;
}

.groups {
	display: grid;
	gap: 6px;
	margin-bottom: 8px;
}

.groups.row {
	display: flex;
	flex-wrap: wrap;
}
</style>
