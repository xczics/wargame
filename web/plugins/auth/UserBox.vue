<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { useGame } from '../../core/game';
import ChangePassword from './ChangePassword.vue';

const game = useGame('auth');
const auth = game.use('auth');
const changing = ref(false);
function changed() {
	changing.value = false;
	game.toast('Password changed', 'info');
}

// On a phone the tabs need the width: only the name stays in the band, the rest (the "user-actions"
// slot, changing the password, logging out) goes into a menu it opens.
const query = matchMedia('(max-width: 743px)');
const narrow = ref(query.matches);
const open = ref(false);
const root = ref<HTMLElement | null>(null);
const onMedia = () => {
	narrow.value = query.matches;
	open.value = false;
};
const onOutside = (e: PointerEvent) => {
	if (root.value && !root.value.contains(e.target as Node)) open.value = false;
};
// A button in the menu has done its job: close it (the password form then opens in its place).
const onMenuClick = (e: MouseEvent) => {
	if ((e.target as HTMLElement).closest('button')) open.value = false;
};
onMounted(() => {
	query.addEventListener('change', onMedia);
	document.addEventListener('pointerdown', onOutside);
});
onBeforeUnmount(() => {
	query.removeEventListener('change', onMedia);
	document.removeEventListener('pointerdown', onOutside);
});
</script>

<template>
	<div ref="root" class="userbox" :class="{ narrow }">
		<template v-if="!narrow">
			<span class="name">👤 {{ auth.user.username }}</span>
			<component :is="s.component" v-for="(s, i) in game.slot('user-actions')" :key="i" v-bind="s.props" />
			<button type="button" class="link" @click="changing = !changing">{{ game.t(changing ? 'Cancel' : 'Change password') }}</button>
			<button type="button" class="link" @click="auth.logout">{{ game.t('Log out') }}</button>
		</template>
		<template v-else>
			<button type="button" class="link name" :aria-expanded="open" @click="open = !open">👤 {{ auth.user.username }} ▾</button>
			<div v-if="open" class="card popover menu" @click="onMenuClick">
				<component :is="s.component" v-for="(s, i) in game.slot('user-actions')" :key="i" v-bind="s.props" />
				<button type="button" class="link" @click="changing = !changing">{{ game.t(changing ? 'Cancel' : 'Change password') }}</button>
				<button type="button" class="link" @click="auth.logout">{{ game.t('Log out') }}</button>
			</div>
		</template>
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

.userbox.narrow {
	flex: none;
	max-width: 40%;
}

.userbox.narrow .name {
	white-space: nowrap;
	overflow: hidden;
	text-overflow: ellipsis;
	max-width: 100%;
	color: var(--text);
	text-decoration: none;
}

.popover {
	position: absolute;
	top: 100%;
	right: 0;
	z-index: 10;
	width: 280px;
	max-width: calc(100vw - 32px);
}

.menu {
	width: auto;
	min-width: 160px;
	display: grid;
	gap: 10px;
	justify-items: start;
}
</style>
