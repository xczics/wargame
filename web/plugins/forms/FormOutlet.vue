<script setup lang="ts">
import { errorText } from '../../core/api';
import { ref, shallowRef, watch } from 'vue';
import type { ClientState, ResolvedForm } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import DynamicForm from './DynamicForm.vue';

// `only`: show just the forms of these commands (e.g. the item picked on the Items page).
const props = withDefaults(defineProps<{ placement?: string; context?: Record<string, string>; only?: string[] }>(), {
	placement: 'global',
	context: () => ({}),
});
const game = useGame('forms');
const forms = shallowRef<ResolvedForm[]>([]);
const error = ref('');

async function load() {
	const q = new URLSearchParams({ ...game.params, ...props.context, placement: props.placement, views: 'ui.forms' });
	try {
		forms.value = ((await game.request<ClientState>(`/api/state?${q}`)).views['ui.forms'] as ResolvedForm[]) ?? [];
		error.value = '';
	} catch (err) {
		error.value = errorText(err);
	}
}

// Availability depends on game state: reload whenever the state or the context changes.
watch([() => game.state.value, () => ({ ...props.context }), () => ({ ...game.params })], load, { immediate: true, deep: true });
</script>

<template>
	<p v-if="error" class="error">{{ game.t(error) }}</p>
	<DynamicForm v-for="f in forms.filter((x) => !only || only.includes(x.command))" :key="f.command" :form="f" />
</template>
