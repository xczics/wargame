<script setup lang="ts">
// A widget button's text: its label, then its parts (e.g. a price, each resource in red when short).
import type { UiAction } from '../../src/shared/ui';
import { useGame } from '../core/game';
import { uiText } from './text';

defineProps<{ action: UiAction }>();
const game = useGame();
</script>

<template>
	<span>{{ uiText(game, action.label) }}</span
	><span v-for="(p, i) in action.parts ?? []" :key="i" class="part" :class="{ short: p.tone === 'warn' }">{{ uiText(game, p.text) }}</span>
</template>

<style scoped>
.part {
	margin-left: 0.3em;
}

/* A light chip keeps a short resource readable on any button, faded (disabled) ones too. */
.short {
	color: var(--danger);
	font-weight: 700;
	background: var(--surface);
	border-radius: 3px;
	padding: 0 3px;
}
</style>
