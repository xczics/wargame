<script setup lang="ts">
// Logged in with an initial password (the GM's first login): the whole UI is this until it is changed.
import { useGame } from '../../core/game';
import ChangePassword from './ChangePassword.vue';

const game = useGame('auth');
const auth = game.use('auth');
const reload = () => location.reload();
</script>

<template>
	<div class="card screen">
		<h1>⚔️ Wargame</h1>
		<p>{{ game.t('{name}: you logged in with the initial password. Choose your own before going on.', { name: auth.user.username }) }}</p>
		<ChangePassword @done="reload" />
		<button type="button" class="link" @click="auth.logout">{{ game.t('Log out') }}</button>
	</div>
</template>

<style scoped>
.screen {
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

p {
	margin: 0;
}
</style>
