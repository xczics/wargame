<script setup lang="ts">
// An icon of the generic widgets: an emoji as text, or an art icon ("art:<scheme>:<key>|<fallback>", src/shared/icons.ts)
// drawn by the renderer a client plugin registered for its scheme at "ui.icon" (a component given `artKey`, `fallback`
// and `size`). The widgets know no scheme; without a renderer the fallback emoji shows.
import { type Component, computed } from 'vue';
import { ICON_POINT, parseIcon } from '../../src/shared/icons';
import { useGame } from '../core/game';

const props = withDefaults(defineProps<{ icon?: string; size?: number }>(), { size: 20 });
const game = useGame('widgets');
const art = computed(() => parseIcon(props.icon));
const renderer = computed(() => (art.value ? game.parts<Component>(ICON_POINT).get(art.value.scheme) : undefined));
</script>

<template>
	<span v-if="art && renderer" class="art" :style="{ width: `${size}px`, height: `${size}px` }"
		><component :is="renderer" :art-key="art.key" :fallback="art.fallback" :size="size"
	/></span>
	<span v-else-if="art ? art.fallback : icon" class="emoji">{{ art ? art.fallback : icon }}</span>
</template>

<style scoped>
.art {
	display: inline-flex;
	align-items: center;
	justify-content: center;
	vertical-align: middle;
	flex: none;
	line-height: 1;
}
</style>
