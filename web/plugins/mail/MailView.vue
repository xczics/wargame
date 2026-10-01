<script setup lang="ts">
import { computed } from 'vue';
import { useGame } from '../../core/game';
import { renderers, selected } from './state';

const game = useGame();
const message = computed(() => game.view('mail.inbox')?.messages.find((m) => m.id === selected.value) ?? null);
const renderer = computed(() => (message.value ? renderers.get(message.value.kind) : undefined));
const vars = (v: Record<string, string | number>) =>
	Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? game.t(x) : x]));

async function remove(id: string) {
	if (!confirm(game.t('Delete this message?'))) return;
	if (await game.command('mail.delete', { ids: [id] })) selected.value = null;
}
</script>

<template>
	<section class="card">
		<template v-if="message">
			<div class="head">
				<h2>{{ game.t(message.title, vars(message.vars)) }}</h2>
				<button type="button" class="small secondary" @click="remove(message.id)">{{ game.t('Delete') }}</button>
			</div>
			<small class="muted">{{ new Date(message.at).toLocaleString() }}</small>
			<component :is="renderer" v-if="renderer" :message="message" />
		</template>
		<p v-else class="muted">{{ game.t('Pick a message on the left.') }}</p>
	</section>
</template>

<style scoped>
.head {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	gap: 8px;
}
</style>
