<script setup lang="ts">
import { formatTime } from '../../core/format';
import { computed } from 'vue';
import { useGame } from '../../core/game';
import { pages, selected } from './state';

const game = useGame('mail');
const message = computed(
	() =>
		[...(game.view('mail.inbox')?.messages ?? []), ...pages.value.flatMap((p) => p.messages)].find((m) => m.id === selected.value) ?? null,
);
// The server says which widget shows each kind of mail (meta `ui.mail`).
const renderer = computed(() => {
	const widget = message.value && game.meta.ui?.mail[message.value.kind];
	return widget ? game.widgetOf(widget) : undefined;
});

async function remove(id: string) {
	if (!confirm(game.t('Delete this message?'))) return;
	if (!(await game.command('mail.delete', { ids: [id] }))) return;
	selected.value = null;
	for (const p of pages.value) p.messages = p.messages.filter((m) => m.id !== id);
}
</script>

<template>
	<section class="card">
		<template v-if="message">
			<div class="head">
				<h2>{{ game.t(message.title) }}</h2>
				<button type="button" class="small secondary" @click="remove(message.id)">{{ game.t('Delete') }}</button>
			</div>
			<small class="muted">{{ formatTime(message.at) }}</small>
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
