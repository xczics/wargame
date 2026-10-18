<script setup lang="ts">
import { computed, shallowRef, type Component } from 'vue';
import type { UiProps } from '../../../src/shared/api';
import type { UiText } from '../../../src/shared/ui';
import { useGame } from '../../core/game';
import AuditTab from './AuditTab.vue';
import BroadcastTab from './BroadcastTab.vue';
import InvitesTab from './InvitesTab.vue';
import ActionsTab from './ActionsTab.vue';
import ReportsTab from './ReportsTab.vue';
import RulesTab from './RulesTab.vue';

const game = useGame('gm-panel');
// The console's own tabs, then those other plugins put in the slot "gm-tabs" (their label in props.label), e.g. puzzles.
const own: Record<string, Component> = {
	Players: ActionsTab,
	Rules: RulesTab,
	Reports: ReportsTab,
	Invites: InvitesTab,
	Broadcast: BroadcastTab,
	Audit: AuditTab,
};
const tabs = computed(() => [
	...Object.entries(own).map(([name, component]) => ({
		id: name,
		label: game.t(name),
		component,
		props: undefined as UiProps | undefined,
	})),
	...game.slot('gm-tabs').map((s, i) => ({
		id: `slot:${i}`,
		label: game.t((s.props?.label as UiText | undefined) ?? ''),
		component: s.component,
		props: s.props,
	})),
]);
const active = shallowRef('Players');
const shown = computed(() => tabs.value.find((t) => t.id === active.value) ?? tabs.value[0]);
</script>

<template>
	<section class="card gm">
		<h2>🛡️ {{ game.t('GM console') }}</h2>
		<nav class="tabs">
			<button v-for="t in tabs" :key="t.id" type="button" :class="{ active: active === t.id }" @click="active = t.id">
				{{ t.label }}
			</button>
		</nav>
		<KeepAlive>
			<component :is="shown.component" :key="shown.id" v-bind="shown.props ?? {}" />
		</KeepAlive>
	</section>
</template>

<style scoped>
.tabs {
	display: flex;
	gap: 4px;
	margin-bottom: 16px;
	border-bottom: 1px solid var(--border);
	overflow-x: auto;
}

.tabs button {
	background: none;
	color: var(--muted);
	border-radius: 0;
	border-bottom: 2px solid transparent;
}

.tabs button.active {
	color: var(--text);
	border-bottom-color: var(--accent);
}
</style>
