<script setup lang="ts">
import type { UiText } from '../../../src/shared/ui';
import { errorText } from '../../core/api';
import { onActivated, onDeactivated, ref, shallowRef, watch } from 'vue';
import type { ClientState, ResolvedForm } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import DynamicForm from './DynamicForm.vue';
import { formsFor } from './cache';

// `only`: show just the forms of these commands (e.g. the item picked on the Items page).
const props = withDefaults(defineProps<{ placement?: string; context?: Record<string, string>; only?: string[] }>(), {
	placement: 'global',
	context: () => ({}),
});
const game = useGame('forms');
const forms = shallowRef<ResolvedForm[]>([]);
const error = ref<string | UiText>('');

// Pages stay alive when hidden (KeepAlive): an outlet there waits, and catches up when shown again.
let active = true;
let stale = false;
async function load() {
	if (!active) return void (stale = true);
	stale = false;
	const q = new URLSearchParams({ ...game.params, ...props.context, placement: props.placement, views: 'ui.forms' });
	try {
		// Outlets asking the same thing of the same state share one request (every page has a global one).
		const state = await formsFor(game.state.value, q.toString(), () => game.request<ClientState>(`/api/state?${q}`));
		forms.value = (state.views['ui.forms'] as ResolvedForm[]) ?? [];
		error.value = '';
	} catch (err) {
		error.value = errorText(err);
	}
}
onActivated(() => {
	active = true;
	if (stale) void load();
});
onDeactivated(() => (active = false));

// Availability depends on game state (a new object after every sync) and on the context.
watch([() => game.state.value, () => JSON.stringify(props.context), () => JSON.stringify(game.params)], load, { immediate: true });
</script>

<template>
	<p v-if="error" class="error">{{ game.t(error) }}</p>
	<DynamicForm v-for="f in forms.filter((x) => !only || only.includes(x.command))" :key="f.command" :form="f" />
</template>
