<script setup lang="ts">
import { computed, onActivated, onDeactivated, onUnmounted, watch } from 'vue';
import type { FormPatches, FormSpecs } from '../../../src/shared/api';
import { resolveForms } from '../../../src/shared/forms';
import { useGame } from '../../core/game';
import DynamicForm from './DynamicForm.vue';

// `only`: show just the forms of these commands (e.g. the item picked on the Items page).
const props = withDefaults(defineProps<{ placement?: string; context?: Record<string, string>; only?: string[] }>(), {
	placement: 'global',
	context: () => ({}),
});
const game = useGame('forms');

// The forms come with every sync and command, as an instance of the data view `forms.patches` for this placement and
// context: no request of its own. Areas asking the same thing share it; hidden pages (KeepAlive) stop asking.
const key = computed(() => `ui.forms|${props.placement}|${JSON.stringify(props.context)}`);
let stop: (() => void) | null = null;
const show = () => {
	stop?.();
	stop = game.instance(key.value, 'forms.patches', { ...props.context, placement: props.placement });
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

// What is available now (data), put together here with the forms' fixed part (static, from R2).
const forms = computed(
	() => resolveForms(game.static<FormSpecs>('forms.specs'), game.state.value?.instances?.[key.value] as FormPatches | undefined) ?? [],
);
</script>

<template>
	<DynamicForm v-for="f in forms.filter((x) => !only || only.includes(x.command))" :key="f.command" :form="f" />
</template>
