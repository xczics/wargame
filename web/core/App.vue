<script setup lang="ts">
import { computed, inject } from 'vue';
import { GameKey, GameUiKey } from './game';

const ui = inject(GameUiKey)!;
const game = inject(GameKey)!;
const page = computed(() => ui.pages.find((p) => p.id === ui.page.value));
</script>

<template>
	<component :is="ui.gate.value" v-if="ui.gate.value" />
	<template v-else>
		<header v-if="ui.slots.top.length || ui.pages.length" class="slot-top">
			<component :is="entry.component" v-for="entry in ui.slots.top" :key="entry.owner" />
			<nav v-if="ui.pages.length > 1" class="pages">
				<button v-for="p in ui.pages" :key="p.id" type="button" :class="{ active: p.id === ui.page.value }" @click="ui.page.value = p.id">
					{{ game.t(p.label) }}
				</button>
			</nav>
		</header>
		<main class="slot-main">
			<component :is="entry.component" v-for="entry in ui.slots.main" :key="entry.owner" />
			<KeepAlive>
				<component :is="page.component" v-if="page" :key="page.id" />
			</KeepAlive>
		</main>
		<aside v-if="ui.slots.side.length" class="slot-side">
			<component :is="entry.component" v-for="entry in ui.slots.side" :key="entry.owner" />
		</aside>
	</template>
	<Transition name="fade">
		<div v-if="ui.toast.value" class="toast" :data-kind="ui.toast.value.kind">{{ ui.toast.value.message }}</div>
	</Transition>
</template>

<style scoped>
.slot-top {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: center;
	gap: 8px 24px;
	padding: 0 16px;
	background: var(--surface);
	border-bottom: 1px solid var(--border);
	position: sticky;
	top: 0;
	z-index: 1;
}

.pages {
	display: flex;
	gap: 4px;
}

.pages button {
	background: none;
	color: var(--muted);
	border-radius: 0;
	border-bottom: 2px solid transparent;
	padding: 10px 12px;
}

.pages button.active {
	color: var(--text);
	border-bottom-color: var(--accent);
}

.slot-main,
.slot-side {
	width: 100%;
	max-width: 960px;
	margin: 0 auto;
	padding: 16px;
	display: grid;
	gap: 16px;
	align-content: start;
}

.toast {
	position: fixed;
	bottom: 24px;
	left: 50%;
	transform: translateX(-50%);
	background: var(--danger);
	color: var(--on-danger);
	padding: 10px 16px;
	border-radius: var(--radius);
	max-width: calc(100% - 32px);
}

.toast[data-kind='info'] {
	background: var(--info);
}

.fade-enter-active,
.fade-leave-active {
	transition: opacity 0.2s;
}

.fade-enter-from,
.fade-leave-to {
	opacity: 0;
}
</style>
