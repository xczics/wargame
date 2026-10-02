<script setup lang="ts">
// The way into the GM console: a badge right of the user name (only for the GM).
import { useGame } from '../../core/game';

const game = useGame('gm-panel');
</script>

<template>
	<button type="button" class="badge gm-badge" :title="game.t('GM console')" @click="game.showPage('gm')">GM</button>
</template>

<style scoped>
.gm-badge {
	border: none;
	cursor: pointer;
}
</style>
