<script setup lang="ts">
import type { User } from '../../../src/shared/api';
import type { UiText } from '../../../src/shared/ui';
import { ApiError, errorText } from '../../core/api';
import { computed, nextTick, reactive, ref } from 'vue';
import { useGame } from '../../core/game';

const game = useGame('auth');
const invite = new URLSearchParams(location.search).get('invite') ?? '';
const mode = ref<'login' | 'register'>(invite ? 'register' : 'login');
const form = reactive({ username: '', password: '', inviteCode: invite });
const error = ref<string | UiText>('');
const busy = ref(false);
const registering = computed(() => mode.value === 'register');

/*
 * The human check (Cloudflare Turnstile), only once the server asks for it (after a few failures: user 2026-10-20). Its
 * public key comes with /api/auth/me; its script is loaded then, once. A token works once: the box is reset after each try.
 */
type Turnstile = {
	render(el: HTMLElement, options: Record<string, unknown>): string;
	reset(id: string): void;
};
const captchaKey = ref<string | null>(null);
const captchaToken = ref('');
const captchaBox = ref<HTMLElement | null>(null);
let widget: string | undefined;
let script: Promise<void> | undefined;
const turnstile = () => (window as unknown as { turnstile?: Turnstile }).turnstile;
function loadTurnstile() {
	script ??= new Promise<void>((ok, ko) => {
		const s = document.createElement('script');
		s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
		s.async = true;
		s.onload = () => ok();
		s.onerror = () => ko(new Error('turnstile'));
		document.head.append(s);
	});
	return script;
}
async function askHuman() {
	captchaKey.value ??= (await game.request<{ captcha?: string }>('/api/auth/me')).captcha ?? null;
	if (!captchaKey.value) return;
	await loadTurnstile();
	await nextTick();
	const t = turnstile();
	if (!t || !captchaBox.value) return;
	captchaToken.value = '';
	if (widget !== undefined) t.reset(widget);
	else
		widget = t.render(captchaBox.value, {
			sitekey: captchaKey.value,
			callback: (token: string) => (captchaToken.value = token),
			'expired-callback': () => (captchaToken.value = ''),
		});
}

function toggle() {
	mode.value = registering.value ? 'login' : 'register';
	error.value = '';
}

async function submit() {
	busy.value = true;
	error.value = '';
	try {
		const { inviteCode, ...credentials } = form;
		const human = captchaToken.value ? { turnstile: captchaToken.value } : {};
		const { user } = await game.request<{ user: User }>(`/api/auth/${mode.value}`, {
			method: 'POST',
			body: { ...(registering.value ? form : credentials), ...human },
		});
		history.replaceState(null, '', '/'); // drop ?invite=
		game.restart(user); // boot the game logged in, without reloading the page (its meta and this answer kept)
	} catch (err) {
		error.value = errorText(err);
		busy.value = false;
		// Asked for (or the box shown already: its token is spent): a fresh check for the next try.
		if ((err instanceof ApiError && (err.code === 'captcha_required' || err.code === 'captcha_failed')) || widget !== undefined)
			await askHuman().catch(() => {});
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
		<div v-show="captchaKey" ref="captchaBox" class="captcha"></div>
		<p v-if="error" class="error">{{ game.t(error) }}</p>
		<button type="submit" :disabled="busy">{{ game.t(registering ? 'Create account' : 'Log in') }}</button>
		<button type="button" class="link" @click="toggle">
			{{ game.t(registering ? 'Already have an account? Log in' : 'Have an invite code? Register') }}
		</button>
	</form>
</template>

<style scoped>
.captcha {
	min-height: 65px;
}

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
