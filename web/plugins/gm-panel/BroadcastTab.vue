<script setup lang="ts">
// To every player at once: a mail in each mailbox, or the banner on every page (rule `mail.announcement`).
import { reactive, ref } from 'vue';
import type { ConfigEntry } from '../../../src/shared/api';
import { useGame } from '../../core/game';

const game = useGame();
const mail = reactive({ title: '', body: '' });
const announcement = ref('');
const sending = ref(false);

async function loadAnnouncement() {
	const rules = await game.request<ConfigEntry[]>('/api/gm/config').catch(() => []);
	const entry = rules.find((r) => r.key === 'mail.announcement');
	announcement.value = typeof entry?.value === 'string' ? entry.value : '';
}
void loadAnnouncement();

async function send() {
	if (!confirm(game.t('Send this mail to every player?'))) return;
	sending.value = true;
	try {
		const { sent } = await game.request<{ sent: number }>('/api/gm/mail/broadcast', { method: 'POST', body: { ...mail } });
		game.toast(game.t('Sent to {n} players', { n: sent }), 'info');
		mail.title = '';
		mail.body = '';
		await game.refresh();
	} catch (err) {
		game.toast(err instanceof Error ? err.message : String(err));
	} finally {
		sending.value = false;
	}
}

async function saveAnnouncement(value: string) {
	try {
		if (value.trim()) await game.request('/api/gm/config/mail.announcement', { method: 'PUT', body: { value } });
		else await game.request('/api/gm/config/mail.announcement', { method: 'DELETE' });
		announcement.value = value.trim();
		game.toast(game.t('Saved'), 'info');
		await game.refresh();
	} catch (err) {
		game.toast(err instanceof Error ? err.message : String(err));
	}
}
</script>

<template>
	<div class="broadcast">
		<form class="block" @submit.prevent="send">
			<h3>{{ game.t('Mail to every player') }}</h3>
			<label>{{ game.t('Title') }} <input v-model="mail.title" maxlength="100" required /></label>
			<label>{{ game.t('Message') }} <textarea v-model="mail.body" maxlength="2000" rows="6" required></textarea></label>
			<button type="submit" :disabled="sending">{{ game.t('Send to everyone') }}</button>
		</form>
		<form class="block" @submit.prevent="saveAnnouncement(announcement)">
			<h3>{{ game.t('Announcement') }}</h3>
			<small class="muted">{{ game.t('Shown at the top of every page until each player dismisses it. Empty: none.') }}</small>
			<input v-model="announcement" maxlength="200" />
			<div class="row">
				<button type="submit">{{ game.t('Save') }}</button>
				<button type="button" class="secondary" @click="saveAnnouncement('')">{{ game.t('Remove') }}</button>
			</div>
		</form>
	</div>
</template>

<style scoped>
.broadcast {
	display: grid;
	gap: 20px;
	max-width: 640px;
}

.block {
	display: grid;
	gap: 8px;
}

.block h3 {
	margin: 0;
}

label {
	display: grid;
	gap: 4px;
}

.row {
	display: flex;
	gap: 8px;
}
</style>
