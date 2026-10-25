<script setup lang="ts">
import { formatTime } from '../../core/format';
import { computed, ref, watch } from 'vue';
import type { MailInbox, Reward, RewardPart } from '../../../src/shared/api';
import { literal } from '../../../src/shared/i18n';
import { useGame } from '../../core/game';
import { bodies, fetchBody, selected } from './state';

const game = useGame('mail');
// What the list knows (read, the attachments' state: they change), and what the message says (fetched once).
// (The newest page and the older ones held: all `mail.inbox`, under their cursors; the latest of each first.)
const header = computed(
	() =>
		game
			.held<MailInbox>('mail.inbox')
			.sort((a, b) => b.at - a.at)
			.flatMap((h) => h.value?.messages ?? [])
			.find((m) => m.id === selected.value) ?? null,
);
const body = computed(() => (selected.value ? bodies.value[selected.value] : undefined));
const message = computed(() => (body.value ? { ...body.value, ...(header.value ?? {}) } : null));
const failed = ref(false);
watch(
	selected,
	(id) => {
		failed.value = false;
		if (id) fetchBody(game, id).catch(() => (failed.value = true));
	},
	{ immediate: true },
);
// The server says which widget shows each kind of mail (meta `ui.mail`).
const renderer = computed(() => {
	const widget = message.value && game.meta.ui?.mail[message.value.kind];
	return widget ? game.widgetOf(widget) : undefined;
});
// The attachments as stored, in words by the part of each kind (the server sends the rewards only).
const input = game.input();
const rewardText = (r: Reward) => game.parts<RewardPart>('rewards.describe').get(r.kind)?.(r.config, input) ?? literal(r.kind);
const claiming = ref(false);

async function remove(id: string) {
	if (!confirm(game.t('Delete this message?'))) return;
	if (!(await game.command('mail.delete', { ids: [id] }))) return;
	selected.value = null;
}

async function claim(id: string) {
	claiming.value = true;
	try {
		await game.command('mail.claim', { id }, { pending: 'Claiming…' });
	} finally {
		claiming.value = false;
	}
}
</script>

<template>
	<section class="card">
		<template v-if="message">
			<div class="head">
				<h2>{{ game.t(message.title) }}</h2>
				<button type="button" class="small secondary" :disabled="message.gift === 'unclaimed'" @click="remove(message.id)">
					{{ game.t('Delete') }}
				</button>
			</div>
			<small class="muted">{{ formatTime(message.at) }}</small>
			<component :is="renderer" v-if="renderer" :message="message" />
			<div v-if="message.attachments?.length" class="attachments">
				<h3>{{ game.t('Attachments') }}</h3>
				<ul>
					<li v-for="(a, i) in message.attachments" :key="i">{{ game.t(rewardText(a)) }}</li>
				</ul>
				<button v-if="message.gift === 'unclaimed'" type="button" :disabled="claiming" @click="claim(message.id)">
					{{ game.t('Claim') }}
				</button>
				<small v-else class="muted">{{ game.t('Claimed') }}</small>
			</div>
		</template>
		<p v-else-if="selected && body === undefined && !failed" class="muted">{{ game.t('Loading…') }}</p>
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

.attachments {
	margin-top: 12px;
	padding-top: 8px;
	border-top: 1px solid var(--border);
	display: grid;
	gap: 6px;
	justify-items: start;
}

.attachments h3 {
	margin: 0;
	font-size: 1em;
}

.attachments ul {
	margin: 0;
	padding-left: 1.2em;
}
</style>
