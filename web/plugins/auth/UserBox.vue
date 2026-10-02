<script setup lang="ts">
import { useGame } from '../../core/game';

const game = useGame();
const auth = game.use('auth');
</script>

<template>
	<div class="userbox">
		<span>👤 {{ auth.user.username }}</span>
		<component :is="s.component" v-for="(s, i) in game.slot('user-actions')" :key="i" v-bind="s.props" />
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
