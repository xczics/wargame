<script setup lang="ts">
// The layout frame (docs/design/ui.md): a fixed top band with the page tabs, a fixed
// bottom band for status marks, and the active page in between. The frame is at most as
// wide as a 13" laptop screen and centred beyond that.
import { computed, inject } from 'vue';
import { GameKey, GameUiKey } from './game';
import LocalePicker from './LocalePicker.vue';
import PageColumns from './PageColumns.vue';

const ui = inject(GameUiKey)!;
const game = inject(GameKey)!;
const page = computed(() => ui.pages.find((p) => p.id === ui.page.value));
const reload = () => location.reload();
// An entry opened over the page (a button's `popup`): the blocks registered on its kind, in a card.
const popupBlocks = computed(() => {
	const e = ui.popup.value;
	return e ? ui.entryBlocks.filter((b) => b.kind === e.kind && (!b.types || (e.type !== undefined && b.types.includes(e.type)))) : [];
});
// A tab with a condition (`when`) shows while that static view says so (e.g. a feature the GM switched on).
const tabs = computed(() =>
	ui.pages.filter((p) => p.tab && (!p.when || !!game.static<Record<string, unknown>>(p.when.static)?.[p.when.field])),
);
</script>

<template>
	<template v-if="ui.gate.value">
		<component :is="ui.gate.value" />
		<LocalePicker class="corner" />
	</template>
	<div v-else class="frame">
		<header class="band top">
			<nav class="tabs">
				<button v-for="p in tabs" :key="p.id" type="button" :class="{ active: p.id === ui.page.value }" @click="ui.page.value = p.id">
					{{ game.t(p.label) }}
				</button>
			</nav>
			<component :is="entry.component" v-for="(entry, i) in ui.bands.top" :key="`${entry.owner}-${i}`" v-bind="entry.props" />
		</header>
		<main class="page">
			<!-- Pages stay alive when switching tabs, so scroll positions and local state survive. -->
			<KeepAlive>
				<div v-if="page?.component" :key="page.id" class="whole">
					<component :is="page.component" v-bind="page.props" />
				</div>
				<PageColumns v-else-if="page" :key="page.id" :page="page.id" />
			</KeepAlive>
		</main>
		<footer class="band bottom">
			<component :is="entry.component" v-for="(entry, i) in ui.bands.bottom" :key="`${entry.owner}-${i}`" v-bind="entry.props" />
			<LocalePicker class="end" />
		</footer>
	</div>
	<Transition name="fade">
		<div v-if="ui.toast.value" class="toast" :data-kind="ui.toast.value.kind">{{ ui.toast.value.message }}</div>
	</Transition>
	<!-- What the player is waiting for: shown at once, gone when the server answers. -->
	<Transition name="fade">
		<div v-if="ui.pending.value" class="pending" role="status" aria-live="polite">
			<span class="spinner" aria-hidden="true"></span>{{ ui.pending.value }}
		</div>
	</Transition>
	<!-- A deploy since the page loaded: not reloaded by itself (a form may be half filled in). -->
	<div v-if="ui.outdated.value" class="outdated" role="status">
		{{ game.t('The game has been updated. Reload to use the new version.') }}
		<button type="button" class="small" @click="reload">{{ game.t('Reload') }}</button>
	</div>
	<Transition name="fade">
		<div v-if="ui.popup.value" class="notice" role="dialog" aria-modal="true" @click.self="ui.popup.value = null">
			<div class="card popup-card">
				<header class="popup-head">
					<strong>{{ game.t(ui.popup.value.label) }}</strong>
					<button type="button" class="link" @click="ui.popup.value = null">{{ game.t('Close') }}</button>
				</header>
				<component
					:is="b.component"
					v-for="(b, i) in popupBlocks"
					:key="`${ui.popup.value.id}-${b.owner}-${i}`"
					v-bind="b.props"
					:entry="ui.popup.value"
				/>
			</div>
		</div>
	</Transition>
	<!-- Covers everything until closed, so a purchase is not repeated by a stray second tap. -->
	<Transition name="fade">
		<div v-if="ui.notice.value" class="notice" role="alertdialog" aria-modal="true" @click.self="ui.notice.value = null">
			<div class="card notice-card">
				<p>{{ ui.notice.value }}</p>
				<button type="button" @click="ui.notice.value = null">{{ game.t('OK') }}</button>
			</div>
		</div>
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
	position: relative;
}

/* The language: at the band's end, off the centred status marks; on the login screens, in a corner. */
.band.bottom .end {
	position: absolute;
	right: 16px;
}

.corner {
	position: fixed;
	right: 16px;
	bottom: 16px;
}

@media (max-width: 640px) {
	.band.bottom .end {
		position: static;
	}
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

.pending {
	position: fixed;
	top: 56px;
	left: 50%;
	transform: translateX(-50%);
	display: flex;
	gap: 8px;
	align-items: center;
	background: var(--surface);
	color: var(--text);
	border: 1px solid var(--border);
	box-shadow: 0 2px 8px var(--scrim);
	padding: 8px 14px;
	border-radius: var(--radius);
	max-width: calc(100% - 32px);
	z-index: 15;
}

.spinner {
	width: 14px;
	height: 14px;
	border: 2px solid var(--border);
	border-top-color: var(--accent);
	border-radius: 50%;
	animation: spin 0.8s linear infinite;
}

@keyframes spin {
	to {
		transform: rotate(360deg);
	}
}

.notice {
	position: fixed;
	inset: 0;
	background: var(--scrim);
	display: grid;
	place-items: center;
	padding: 16px;
	z-index: 20;
}

.notice-card {
	max-width: 420px;
	width: 100%;
	text-align: center;
	font-size: 1.1em;
}

.outdated {
	position: fixed;
	top: 8px;
	left: 50%;
	transform: translateX(-50%);
	z-index: 30;
	display: flex;
	align-items: center;
	gap: 10px;
	padding: 8px 12px;
	border-radius: 8px;
	background: var(--surface);
	border: 1px solid var(--accent);
	box-shadow: 0 4px 16px var(--scrim);
	max-width: calc(100vw - 32px);
}

.popup-card {
	max-width: 520px;
	width: 100%;
	max-height: 80vh;
	overflow-y: auto;
	display: flex;
	flex-direction: column;
	gap: 12px;
}

.popup-head {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	gap: 12px;
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
