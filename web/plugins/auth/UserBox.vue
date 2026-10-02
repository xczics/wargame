<script setup lang="ts">
import { ref } from 'vue';
import { useGame } from '../../core/game';
import ChangePassword from './ChangePassword.vue';

const game = useGame('auth');
const auth = game.use('auth');
const changing = ref(false);
function changed() {
	changing.value = false;
	game.toast('Password changed', 'info');
}
</script>

<template>
	<div class="userbox">
		<span>👤 {{ auth.user.username }}</span>
		<component :is="s.component" v-for="(s, i) in game.slot('user-actions')" :key="i" v-bind="s.props" />
		<button type="button" class="link" @click="changing = !changing">{{ game.t(changing ? 'Cancel' : 'Change password') }}</button>
		<button type="button" class="link" @click="auth.logout">{{ game.t('Log out') }}</button>
		<div v-if="changing" class="card popover"><ChangePassword @done="changed" /></div>
	</div>
</template>

<style scoped>
.userbox {
	display: flex;
	gap: 8px;
	align-items: center;
	padding: 8px 0;
	position: relative;
}

.popover {
	position: absolute;
	top: 100%;
	right: 0;
	z-index: 10;
	width: 280px;
}
</style>
