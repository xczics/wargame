<script setup lang="ts">
import { computed, onActivated, onDeactivated, onUnmounted, watch } from 'vue';
import type { ResolvedForm } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import DynamicForm from './DynamicForm.vue';

// `only`: show just the forms of these commands (e.g. the item picked on the Items page).
const props = withDefaults(defineProps<{ placement?: string; context?: Record<string, string>; only?: string[] }>(), {
	placement: 'global',
	context: () => ({}),
});
const game = useGame('forms');

// The forms come with every sync and command, as an instance of the view `ui.forms` for this placement and
// context: no request of its own. Areas asking the same thing share it; hidden pages (KeepAlive) stop asking.
const key = computed(() => `ui.forms|${props.placement}|${JSON.stringify(props.context)}`);
let stop: (() => void) | null = null;
const show = () => {
	stop?.();
	stop = game.instance(key.value, 'ui.forms', { ...props.context, placement: props.placement });
};
const hide = () => {
	stop?.();
	stop = null;
};
show();
watch(key, () => stop && show());
onActivated(show);
onDeactivated(hide);
onUnmounted(hide);

const forms = computed(() => (game.state.value?.instances?.[key.value] as ResolvedForm[] | undefined) ?? []);
</script>

<template>
	<DynamicForm v-for="f in forms.filter((x) => !only || only.includes(x.command))" :key="f.command" :form="f" />
</template>
