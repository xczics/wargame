<script setup lang="ts">
// Generic widget "ui.badge": a short line (bold label, value, tooltip) from the view the server names.
import { computed } from 'vue';
import type { BadgeData } from '../../src/shared/ui';
import { useGame } from '../core/game';
import { uiText } from './text';

const props = defineProps<{ view: string }>();
const game = useGame('widgets');
const data = computed(() => (game.state.value?.views[props.view] ?? null) as BadgeData | null);
</script>

<template>
	<span v-if="data" class="badge-line" :title="uiText(game, data.title)">
		<strong v-if="data.label">{{ uiText(game, data.label) }}</strong>
		<template v-if="data.label && data.value"> · </template>
		<template v-if="data.value">{{ uiText(game, data.value) }}</template>
	</span>
</template>

<style scoped>
.badge-line {
	font-size: 0.85em;
	color: var(--muted);
	white-space: nowrap;
}

.badge-line strong {
	color: var(--text);
}
</style>
