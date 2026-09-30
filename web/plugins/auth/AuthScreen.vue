<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import { useGame } from '../../core/game';

const game = useGame();
const invite = new URLSearchParams(location.search).get('invite') ?? '';
const mode = ref<'login' | 'register'>(invite ? 'register' : 'login');
const form = reactive({ username: '', password: '', inviteCode: invite });
const error = ref('');
const busy = ref(false);
const registering = computed(() => mode.value === 'register');

function toggle() {
	mode.value = registering.value ? 'login' : 'register';
	error.value = '';
}

async function submit() {
	busy.value = true;
	error.value = '';
	try {
		const { inviteCode, ...credentials } = form;
		await game.request(`/api/auth/${mode.value}`, { method: 'POST', body: registering.value ? form : credentials });
		location.replace('/'); // drop ?invite= and boot the game logged in
	} catch (err) {
		error.value = err instanceof Error ? err.message : String(err);
		busy.value = false;
	}
}
</script>

<template>
	<form class="card auth" @submit.prevent="submit">
		<h1>⚔️ Wargame</h1>
		<label>{{ game.t('Username') }} <input v-model.trim="form.username" autocomplete="username" required /></label>
		<label>
			{{ game.t('Password') }}
			<input v-model="form.password" type="password" :autocomplete="registering ? 'new-password' : 'current-password'" required />
		</label>
		<label v-if="registering">{{ game.t('Invite code') }} <input v-model.trim="form.inviteCode" autocomplete="off" required /></label>
		<p v-if="error" class="error">{{ game.t(error) }}</p>
		<button type="submit" :disabled="busy">{{ game.t(registering ? 'Create account' : 'Log in') }}</button>
		<button type="button" class="link" @click="toggle">
			{{ game.t(registering ? 'Already have an account? Log in' : 'Have an invite code? Register') }}
		</button>
	</form>
</template>

<style scoped>
.auth {
	max-width: 360px;
	margin: 10vh auto 0;
	display: grid;
	gap: 12px;
}

h1 {
	margin: 0;
	text-align: center;
	font-size: 1.4rem;
}
</style>
