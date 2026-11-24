<script setup lang="ts">
// Form field widget "armies.arrival" (added by ./forms.ts to the forms sending troops): when the march would arrive, worked
// out here as the units, the origin and the target change, by the same formulas as the server's (./travel.ts). Sends nothing.
import { computed } from 'vue';
import type { FormField } from '../../../src/shared/api';
import { duration } from '../../../src/shared/format';
import { uiTexts } from '../../../src/shared/i18n';
import { formatTime } from '../../core/format';
import { useGame } from '../../core/game';
import Txt from '../../widgets/Txt.vue';
import { orderOf } from './travel';

const props = defineProps<{ field: FormField; values: Record<string, string | number | boolean>; payload?: Record<string, unknown> }>();
const game = useGame('armies');
// The server plugin's words (its i18n keys).
const text = uiTexts('armies');
const seconds = computed(() => {
	const order = orderOf(props.payload);
	if (!order || !Object.keys(order.units).length) return null;
	return game.use('armies').seconds(order, !!(props.field.data as { own?: boolean } | undefined)?.own);
});
// To the minute (the time is shown so): the words change once a minute, not with every tick of the clock.
const at = computed(() => (seconds.value === null ? null : Math.floor((game.serverNow() + seconds.value * 1000) / 60_000)));
const line = computed(() =>
	seconds.value === null || at.value === null
		? null
		: text('Arrives in {0} (at {1})', { 0: duration(seconds.value), 1: formatTime(at.value * 60_000) }),
);
</script>

<template>
	<p v-if="line" class="arrival"><Txt :text="line" /></p>
</template>

<style scoped>
.arrival {
	margin: 4px 0;
	color: var(--muted);
}
</style>
