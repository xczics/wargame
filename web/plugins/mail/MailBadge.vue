<script setup lang="ts">
import { computed } from 'vue';
import { useGame } from '../../core/game';

const game = useGame();
const unread = computed(() => game.view('mail.inbox')?.unread ?? 0);
</script>

<template>
	<button
		type="button"
		class="link mail-badge"
		:class="{ unread }"
		:title="game.t('{n} unread', { n: unread })"
		@click="game.use('mail').open()"
	>
		✉️<span v-if="unread" class="count">{{ unread }}</span>
	</button>
</template>

<style scoped>
.mail-badge {
	display: inline-flex;
	align-items: center;
	gap: 2px;
	padding: 8px 4px;
}

.count {
	min-width: 1.4em;
	padding: 0 4px;
	border-radius: 999px;
	background: var(--danger);
	color: var(--on-danger);
	font-size: 0.75em;
	text-align: center;
}
</style>
