<script setup lang="ts">
import { shallowRef, type Component } from 'vue';
import { useGame } from '../../core/game';
import AuditTab from './AuditTab.vue';
import BroadcastTab from './BroadcastTab.vue';
import InvitesTab from './InvitesTab.vue';
import ActionsTab from './ActionsTab.vue';
import ReportsTab from './ReportsTab.vue';
import RulesTab from './RulesTab.vue';

const tabs: Record<string, Component> = {
	Players: ActionsTab,
	Rules: RulesTab,
	Reports: ReportsTab,
	Invites: InvitesTab,
	Broadcast: BroadcastTab,
	Audit: AuditTab,
};
const active = shallowRef('Players');
const game = useGame('gm-panel');
</script>

<template>
	<section class="card gm">
		<h2>🛡️ {{ game.t('GM console') }}</h2>
		<nav class="tabs">
			<button v-for="(_, name) in tabs" :key="name" type="button" :class="{ active: active === name }" @click="active = name">
				{{ game.t(name) }}
			</button>
		</nav>
		<KeepAlive>
			<component :is="tabs[active]" :key="active" />
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
