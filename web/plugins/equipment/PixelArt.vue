<script setup lang="ts">
// Pixel layers drawn into a canvas at their own size, scaled up by whole numbers with no smoothing (`scale`, else the
// CSS variable --px of the parent).
import { ref, watchEffect } from 'vue';
import { type Box, compose, type PixelLayer } from './pixels';

const props = defineProps<{ layers: PixelLayer[]; box: Box; scale?: number }>();
const canvas = ref<HTMLCanvasElement | null>(null);
watchEffect(() => {
	const c = canvas.value;
	const [, , w, h] = props.box;
	if (!c || !w || !h) return;
	c.width = w;
	c.height = h;
	const rgba = compose(props.layers, props.box);
	c.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
});
</script>

<template>
	<canvas
		ref="canvas"
		class="pixels"
		aria-hidden="true"
		:style="
			scale
				? { width: `${box[2] * scale}px`, height: `${box[3] * scale}px` }
				: { width: `calc(${box[2]}px * var(--px, 3))`, height: `calc(${box[3]}px * var(--px, 3))` }
		"
	/>
</template>

<style scoped>
.pixels {
	display: block;
	image-rendering: crisp-edges;
	image-rendering: pixelated;
}
</style>
