<script setup lang="ts">
// The renderer of the art icon scheme "equipment" (registered at "ui.icon", web/widgets/Icon.vue): a piece's icon from
// "<set>/<slot>/<rarity>", drawn from the art pack a content plugin gave (`equipment.setArt`) at the largest whole scale
// that fits `size`, as on the paper doll. Without art for it: the fallback emoji.
import { computed } from 'vue';
import { equipmentIconKey } from '../../../src/shared/equipment';
import { useGame } from '../../core/game';
import { iconLayers } from './art';
import PixelArt from './PixelArt.vue';
import { fitScale } from './pixels';

const props = defineProps<{ artKey: string; fallback: string; size: number }>();
const art = useGame('equipment').use('equipment').art;
const icon = computed(() => {
	const a = art.value;
	const p = equipmentIconKey(props.artKey);
	// Pieces as drawn on the hero (an art pack draws a heroine's own pieces on her).
	const pa = a && p ? a.piece(p, 'm') : null;
	return a && pa ? { layers: iconLayers(a, pa), box: pa.icon, scale: fitScale(pa.icon, props.size) } : null;
});
</script>

<template>
	<PixelArt v-if="icon" v-bind="icon" />
	<span v-else>{{ fallback }}</span>
</template>
