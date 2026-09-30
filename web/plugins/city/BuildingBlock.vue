<script setup lang="ts">
// First block of a building entry: the building's level, effects, upgrade or construction,
// found again in the current state so it stays live. Other plugins' blocks follow it.
import { computed } from 'vue';
import type { Entry } from '../../core/game';
import { useGame } from '../../core/game';
import SlotCard from './SlotCard.vue';

const props = defineProps<{ entry: Entry }>();
const game = useGame();
const detail = computed(() => game.view('settlements.detail'));
const found = computed(() => {
	const { settlement, district, slot } = props.entry.data ?? {};
	if (detail.value?.id !== settlement) return null;
	const d = detail.value.districts.find((x) => x.id === district);
	const info = d?.slots.find((s) => String(s.slot) === slot);
	return d && info ? { district: d.id, info } : null;
});
</script>

<template>
	<SlotCard v-if="found" :settlement="entry.data!.settlement" :district="found.district" :info="found.info" detailed />
	<p v-else class="muted">{{ game.t('This building is not in the selected settlement.') }}</p>
</template>
