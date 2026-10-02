<script setup lang="ts">
// Change the logged-in account's own password (the current one, then the new one twice).
import type { UiText } from '../../../src/shared/ui';
import { reactive, ref } from 'vue';
import type { ChangePasswordRequest } from '../../../src/shared/api';
import { errorText } from '../../core/api';
import { useGame } from '../../core/game';

const emit = defineEmits<{ done: [] }>();
const game = useGame('auth');
const form = reactive({ oldPassword: '', newPassword: '', repeat: '' });
const error = ref<string | UiText>('');
const busy = ref(false);

async function submit() {
	error.value = '';
	if (form.newPassword !== form.repeat) {
		error.value = 'The new passwords do not match';
		return;
	}
	busy.value = true;
	try {
		const body: ChangePasswordRequest = { oldPassword: form.oldPassword, newPassword: form.newPassword };
		await game.request('/api/auth/password', { method: 'POST', body });
		Object.assign(form, { oldPassword: '', newPassword: '', repeat: '' });
		emit('done');
	} catch (err) {
		error.value = errorText(err);
	} finally {
		busy.value = false;
	}
}
</script>

<template>
	<form class="change-password" @submit.prevent="submit">
		<label>
			{{ game.t('Current password') }}
			<input v-model="form.oldPassword" type="password" autocomplete="current-password" required />
		</label>
		<label>
			{{ game.t('New password') }}
			<input v-model="form.newPassword" type="password" autocomplete="new-password" minlength="8" maxlength="128" required />
		</label>
		<label>
			{{ game.t('New password again') }}
			<input v-model="form.repeat" type="password" autocomplete="new-password" required />
		</label>
		<p class="hint">{{ game.t('8-128 characters') }}</p>
		<p v-if="error" class="error">{{ game.t(error) }}</p>
		<button type="submit" :disabled="busy">{{ game.t('Change password') }}</button>
	</form>
</template>

<style scoped>
.change-password {
	display: grid;
	gap: 12px;
}

.hint {
	margin: 0;
	color: var(--muted);
	font-size: 0.85rem;
}
</style>
