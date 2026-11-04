<script setup lang="ts">
// Server time, ticking: `game.serverNow()` reads `game.elapsed`, which changes every second.
import { computed } from 'vue';
import { useGame } from '../../web/core/game';
import Icon from '../../web/widgets/Icon.vue';
import type { ClockSettings } from './types';

const props = defineProps<{ view: string }>();
const game = useGame('clock');
const settings = computed(() => (game.state.value?.views[props.view] ?? null) as ClockSettings | null);
const time = computed(() => {
	const shifted = new Date(game.serverNow() + (settings.value?.utcOffset ?? 0) * 3600_000);
	return shifted.toISOString().slice(11, 19);
});
</script>

<template>
	<small v-if="settings" class="clock"><Icon icon="hourglass" :size="16" /> {{ game.t('Server time') }} {{ time }}</small>
</template>

<style scoped>
.clock {
	color: var(--muted);
	font-variant-numeric: tabular-nums;
}
</style>
