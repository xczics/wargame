<script setup lang="ts">
// Generic widget "ui.banner": a notice across the page (e.g. the GM's announcement). A player can hide
// it; it comes back when its `key` changes (a new notice). Plain text only.
import { computed, ref } from 'vue';
import type { BannerData } from '../../src/shared/ui';
import { useGame } from '../core/game';
import { uiText } from './text';

const props = defineProps<{ view: string }>();
const game = useGame();
const data = computed(() => (game.state.value?.views[props.view] ?? null) as BannerData | null);
const storeKey = `banner:${props.view}`;
const hidden = ref(read());
function read() {
	try {
		return localStorage.getItem(storeKey) ?? '';
	} catch {
		return '';
	}
}
function hide() {
	hidden.value = data.value?.key ?? '';
	try {
		localStorage.setItem(storeKey, hidden.value);
	} catch {
		/* private mode: hidden for this page only */
	}
}
</script>

<template>
	<div v-if="data && data.key !== hidden" class="banner">
		<span>{{ data.icon ?? '' }} {{ uiText(game, data.text) }}</span>
		<button type="button" class="link" @click="hide">{{ game.t('Dismiss') }}</button>
	</div>
</template>

<style scoped>
.banner {
	display: flex;
	gap: 12px;
	align-items: center;
	padding: 4px 10px;
	border: 1px solid var(--accent);
	border-radius: var(--radius);
	color: var(--text);
}
</style>
