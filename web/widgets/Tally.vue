<script setup lang="ts">
// Generic form field widget "ui.tally" (data: TallyData): how many of the items the form's choices pick now and what
// they add up to, counted here as the player chooses (the items come once, with the form). It sends nothing.
import { computed } from 'vue';
import type { FormField } from '../../src/shared/api';
import { amounts } from '../../src/shared/format';
import type { TallyData } from '../../src/shared/ui';
import { useGame } from '../core/game';
import { uiText } from './text';

const props = defineProps<{ field: FormField; values: Record<string, string | number | boolean> }>();
const game = useGame('widgets');
const data = computed(() => props.field.data as TallyData);
const picked = computed(() =>
	data.value.items.filter((it) => data.value.fields.every((f) => !props.values[f] || String(props.values[f]) === it.match[f])),
);
const total = computed(() => {
	const out: Record<string, number> = {};
	for (const it of picked.value) for (const [k, n] of Object.entries(it.amounts)) out[k] = (out[k] ?? 0) + n;
	return out;
});
</script>

<template>
	<p class="tally" :class="{ muted: !picked.length }">
		{{
			picked.length
				? uiText(game, { ...data.summary, vars: { 0: picked.length, 1: amounts(total, data.icons) } })
				: uiText(game, data.empty)
		}}
	</p>
</template>

<style scoped>
.tally {
	margin: 4px 0;
	font-weight: 600;
}

.tally.muted {
	color: var(--muted);
	font-weight: normal;
}
</style>
