<script setup lang="ts">
// The templates of one kind (user 2026-10-20 / gameplay.md §15.5.1: "常用的规则（练级、加点、攻打）和建筑的批量任务可以存成模板，
// 以后一键再用"): each a chip, a click makes a new one from it, ✕ forgets it. Saving is the panels' (their rules' headers).
import { computed } from 'vue';
import { useGame } from '../../core/game';
import type { Store, TemplateKind } from './store';

const props = defineProps<{ store: Store; kind: TemplateKind }>();
const emit = defineEmits<{ apply: [value: unknown] }>();
const game = useGame('assistant');
const list = computed(() => (props.store.data.templates ?? []).filter((x) => x.kind === props.kind));
function forget(id: string) {
	const all = props.store.data.templates ?? [];
	const i = all.findIndex((x) => x.id === id);
	if (i >= 0) all.splice(i, 1);
}
</script>

<template>
	<span v-if="list.length" class="templates">
		<span class="muted">{{ game.t('From a template:') }}</span>
		<span v-for="x in list" :key="x.id" class="chip">
			<button type="button" class="small secondary" @click="emit('apply', JSON.parse(JSON.stringify(x.value)))">{{ x.name }}</button>
			<button type="button" class="small secondary" :title="game.t('Forget this template')" @click="forget(x.id)">✕</button>
		</span>
	</span>
</template>

<style scoped>
.templates {
	display: inline-flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 8px;
}

.chip {
	display: inline-flex;
	gap: 2px;
}

.muted {
	color: var(--muted);
}
</style>
