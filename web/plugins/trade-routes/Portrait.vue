<script setup lang="ts">
// Who the story shows at a place: a portrait from the art a client content plugin gave (`tradeRoutes.addPortrait`), in
// an old frame; or anyone's face by a seed (a hero by its id, an enemy general by where it stands); nothing when there
// is none.
import { computed } from 'vue';
import { useGame } from '../../core/game';
import PixelArt from '../../widgets/PixelArt.vue';

const props = defineProps<{ id?: string; seed?: string; gender?: 'm' | 'f'; scale?: number }>();
const game = useGame('trade-routes');
const art = computed(() => {
	const routes = game.use('tradeRoutes');
	if (props.id) return routes.portrait(props.id);
	return props.seed ? routes.face(props.seed, props.gender) : undefined;
});
</script>

<template>
	<figure v-if="art" class="portrait" :class="{ small: (scale ?? 3) < 2 }">
		<PixelArt
			:layers="[{ sprite: { x: 0, y: 0, rows: art.rows }, palette: art.palette }]"
			:box="[0, 0, art.rows[0].length, art.rows.length]"
			:scale="scale ?? 3"
		/>
	</figure>
</template>

<style scoped>
.portrait.small {
	padding: 1px;
	border-width: 1px;
}

.portrait {
	margin: 0;
	padding: 4px;
	background: var(--map-paper-edge);
	border: 2px solid var(--map-ink);
	border-radius: 4px;
	width: fit-content;
}
</style>
