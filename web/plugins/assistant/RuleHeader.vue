<script setup lang="ts">
// A rule's header in the assistant's panels: on / off with its name (turning it on again clears a stop), what it says
// of itself (the default slot), and its tools: edit, copy, the "tools" slot's, remove.
import { useGame } from '../../core/game';

const props = defineProps<{ rule: { on: boolean; name: string; stopped?: string }; editing: boolean }>();
const emit = defineEmits<{ edit: []; copy: []; remove: [] }>();
const game = useGame('assistant');
</script>

<template>
	<header class="row">
		<label class="chip"
			><input v-model="props.rule.on" type="checkbox" @change="props.rule.stopped = undefined" />
			<strong>{{ props.rule.name }}</strong></label
		>
		<slot />
		<span class="tools">
			<button type="button" class="small secondary" @click="emit('edit')">{{ game.t(props.editing ? 'Done' : 'Edit') }}</button>
			<button type="button" class="small secondary" @click="emit('copy')">{{ game.t('Copy') }}</button>
			<slot name="tools" />
			<button type="button" class="small secondary" @click="emit('remove')">✕</button>
		</span>
	</header>
</template>

<style scoped>
.row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px 10px;
}

.chip {
	display: inline-flex;
	align-items: center;
	gap: 4px;
}

.tools {
	display: inline-flex;
	gap: 4px;
	margin-left: auto;
}
</style>
