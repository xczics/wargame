<script setup lang="ts">
import { computed } from 'vue';
import type { ConfigEntry } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import RuleEditor from './RuleEditor.vue';
import { useResource } from './useResource';

const game = useGame();
const { data: rules, error, reload } = useResource<ConfigEntry[]>(() => '/api/gm/config');
const groups = computed(() => {
	const out = new Map<string, ConfigEntry[]>();
	for (const r of rules.value ?? []) out.set(r.owner, [...(out.get(r.owner) ?? []), r]);
	return [...out.entries()];
});
const pluginName = (id: string) => (game.t(`plugin:${id}`) === `plugin:${id}` ? id : game.t(`plugin:${id}`));
</script>

<template>
	<p class="muted">{{ game.t('Changes apply to every player immediately, including their pending offline time.') }}</p>
	<p v-if="error" class="error">{{ game.t(error) }}</p>
	<details v-for="[owner, list] in groups" :key="owner" class="group">
		<summary>
			<strong>{{ pluginName(owner) }}</strong>
			<small class="muted"> · {{ list.length }}</small>
			<span v-if="list.some((r) => r.overridden)" class="badge">{{ game.t('changed') }}</span>
		</summary>
		<RuleEditor v-for="rule in list" :key="rule.key" :rule="rule" @changed="reload" />
	</details>
</template>

<style scoped>
.group {
	border-bottom: 1px solid var(--border);
	padding: 8px 0;
}

summary {
	cursor: pointer;
	padding: 4px 0;
}
</style>
