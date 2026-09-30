<script setup lang="ts">
import { useGame } from '../../core/game';

const game = useGame();
const auth = game.use('auth');
</script>

<template>
	<div class="userbox">
		<span>👤 {{ auth.user.username }}</span>
		<span v-if="auth.user.gm" class="badge">GM</span>
		<button type="button" class="link" @click="auth.logout">{{ game.t('Log out') }}</button>
	</div>
</template>

<style scoped>
.userbox {
	display: flex;
	gap: 8px;
	align-items: center;
	padding: 8px 0;
}
</style>
