<script setup lang="ts">
// Generic widget "ui.filters": a heading, summary lines, one button per group of a cards view, a note.
// The choice is shared with the "ui.cards" of the same \`filter\`.
import { computed } from 'vue';
import type { CardsData } from '../../src/shared/ui';
import { useGame } from '../core/game';
import { chosen } from './state';
import { uiText } from './text';

const props = defineProps<{ view: string; filter: string }>();
const game = useGame();
const data = computed(() => (game.state.value?.views[props.view] ?? null) as CardsData | null);
const count = (group: string) => (data.value?.cards ?? []).filter((c) => c.group === group).length;
const pick = (group: string | null) => (chosen[props.filter] = group);
</script>

<template>
	<section v-if="data" class="card">
		<h2 v-if="data.title">{{ uiText(game, data.title) }}</h2>
		<p v-for="(s, i) in data.summary ?? []" :key="i" class="summary">{{ uiText(game, s) }}</p>
		<div v-if="data.groups?.length" class="groups">
			<button type="button" class="small" :class="{ secondary: (chosen[filter] ?? null) !== null }" @click="pick(null)">
				{{ game.t('All') }} ({{ data.cards.length }})
			</button>
			<button
				v-for="g in data.groups"
				:key="g.id"
				type="button"
				class="small"
				:class="{ secondary: chosen[filter] !== g.id }"
				@click="pick(g.id)"
			>
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
</style>
