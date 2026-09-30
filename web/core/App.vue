<script setup lang="ts">
// The layout frame (docs/design/ui.md): a fixed top band with the page tabs, a fixed
// bottom band for status marks, and the active page in between. The frame is at most as
// wide as a 13" laptop screen and centred beyond that.
import { computed, inject } from 'vue';
import { GameKey, GameUiKey } from './game';
import PageColumns from './PageColumns.vue';

const ui = inject(GameUiKey)!;
const game = inject(GameKey)!;
const page = computed(() => ui.pages.find((p) => p.id === ui.page.value));
</script>

<template>
	<component :is="ui.gate.value" v-if="ui.gate.value" />
	<div v-else class="frame">
		<header class="band top">
			<nav class="tabs">
				<button v-for="p in ui.pages" :key="p.id" type="button" :class="{ active: p.id === ui.page.value }" @click="ui.page.value = p.id">
					{{ game.t(p.label) }}
				</button>
			</nav>
			<component :is="entry.component" v-for="entry in ui.bands.top" :key="entry.owner" />
		</header>
		<main class="page">
			<!-- Pages stay alive when switching tabs, so scroll positions and local state survive. -->
			<KeepAlive>
				<div v-if="page?.component" :key="page.id" class="whole">
					<component :is="page.component" />
				</div>
				<PageColumns v-else-if="page" :key="page.id" :page="page.id" />
			</KeepAlive>
		</main>
		<footer v-if="ui.bands.bottom.length" class="band bottom">
			<component :is="entry.component" v-for="entry in ui.bands.bottom" :key="entry.owner" />
		</footer>
	</div>
	<Transition name="fade">
		<div v-if="ui.toast.value" class="toast" :data-kind="ui.toast.value.kind">{{ ui.toast.value.message }}</div>
	</Transition>
</template>

<style scoped>
.frame {
	height: 100vh;
	height: 100dvh;
	max-width: 1440px;
	margin: 0 auto;
	display: grid;
	grid-template-rows: auto minmax(0, 1fr) auto;
	background: var(--bg);
	border-inline: 1px solid var(--border);
}

.band {
	display: flex;
	align-items: center;
	gap: 8px 16px;
	padding: 0 16px;
	background: var(--surface);
	min-width: 0;
}

.band.top {
	border-bottom: 1px solid var(--border);
}

.band.bottom {
	border-top: 1px solid var(--border);
	justify-content: center;
}

.tabs {
	display: flex;
	gap: 4px;
	flex: 1;
	min-width: 0;
	overflow-x: auto;
	scrollbar-width: none;
}

.tabs button {
	background: none;
	color: var(--muted);
	border-radius: 0;
	border-bottom: 2px solid transparent;
	padding: 10px 12px;
	white-space: nowrap;
}

.tabs button.active {
	color: var(--text);
	border-bottom-color: var(--accent);
}

.page {
	min-height: 0;
	overflow: hidden;
}

.whole {
	height: 100%;
	overflow: auto;
	padding: 16px;
	display: flex;
	flex-direction: column;
	gap: 16px;
}

@media (max-width: 743px) {
	.frame {
		border-inline: none;
	}

	.page {
		overflow-y: auto;
	}
}

.toast {
	position: fixed;
	bottom: 64px;
	left: 50%;
	transform: translateX(-50%);
	background: var(--danger);
	color: var(--on-danger);
	padding: 10px 16px;
	border-radius: var(--radius);
	max-width: calc(100% - 32px);
	z-index: 10;
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
