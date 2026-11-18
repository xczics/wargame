<script setup lang="ts">
// Who the story shows at a place: a portrait from the art a client content plugin gave (`tradeRoutes.addPortrait`), in
// an old frame; nothing when there is none.
import { computed } from 'vue';
import { useGame } from '../../core/game';
import PixelArt from '../../widgets/PixelArt.vue';

const props = defineProps<{ id?: string; scale?: number }>();
const game = useGame('trade-routes');
const art = computed(() => (props.id ? game.use('tradeRoutes').portrait(props.id) : undefined));
</script>

<template>
	<figure v-if="art" class="portrait">
		<PixelArt
			:layers="[{ sprite: { x: 0, y: 0, rows: art.rows }, palette: art.palette }]"
			:box="[0, 0, art.rows[0].length, art.rows.length]"
			:scale="scale ?? 3"
		/>
	</figure>
</template>

<style scoped>
.portrait {
	margin: 0;
	padding: 4px;
	background: var(--map-paper-edge);
	border: 2px solid var(--map-ink);
	border-radius: 4px;
	width: fit-content;
}
</style>
