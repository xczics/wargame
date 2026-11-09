<script setup lang="ts">
// The renderer of the art icon scheme "icon": an icon id's sprite at the largest whole scale that fits `size` (pixels
// stay square and sharp, like the equipment's), or halved for a sprite larger than that. Each sprite is made once into an image (a map shows hundreds of
// icons: one canvas each would be far heavier).
import { computed } from 'vue';
import { useGame } from '../../core/game';
import { fitScale } from '../../widgets/pixels';
import { iconImage } from './image';

const props = defineProps<{ artKey: string; fallback: string; size: number }>();
const icons = useGame('icons').use('icons');
const icon = computed(() => {
	const a = icons.get(props.artKey);
	const image = a && iconImage(a);
	if (!image) return null;
	// A sprite drawn larger than the room (32 x 32 for more detail): halved until it fits, so it stays as large as the
	// 16 x 16 ones beside it; otherwise the largest whole scale.
	const side = Math.max(image.w, image.h);
	const scale = side <= props.size ? fitScale([0, 0, image.w, image.h], props.size) : 2 ** Math.floor(Math.log2(props.size / side));
	return { ...image, scale };
});
</script>

<template>
	<img
		v-if="icon"
		class="pixels"
		:src="icon.url"
		alt=""
		aria-hidden="true"
		:style="{ width: `${icon.w * icon.scale}px`, height: `${icon.h * icon.scale}px` }"
	/>
</template>

<style scoped>
.pixels {
	display: block;
	image-rendering: crisp-edges;
	image-rendering: pixelated;
}
</style>
