<script setup lang="ts">
// An icon of the generic widgets: an icon id or an art icon ("art:<scheme>:<key>|<fallback>", src/shared/icons.ts),
// drawn by the renderer a client plugin registered for its scheme at "ui.icon" (a component given `artKey`,
// `fallback` and `size`; icon ids are the scheme "icon"). The widgets know no scheme. An art icon without a renderer
// draws its fallback id; an emoji (a third party's older data) shows as text.
import { type Component, computed } from 'vue';
import { ICON_POINT, ICON_SET, parseIcon } from '../../src/shared/icons';
import { useGame } from '../core/game';

const props = withDefaults(defineProps<{ icon?: string; size?: number }>(), { size: 20 });
const game = useGame('widgets');
const drawn = computed(() => {
	const art = parseIcon(props.icon);
	if (!art) return null;
	const renderers = game.parts<Component>(ICON_POINT);
	const own = renderers.get(art.scheme);
	if (own) return { renderer: own, key: art.key, fallback: art.fallback };
	const set = art.fallback ? renderers.get(ICON_SET) : undefined;
	return set ? { renderer: set, key: art.fallback, fallback: '' } : null;
});
</script>

<template>
	<span v-if="drawn" class="art" :style="{ width: `${size}px`, height: `${size}px` }"
		><component :is="drawn.renderer" :art-key="drawn.key" :fallback="drawn.fallback" :size="size"
	/></span>
	<span v-else-if="icon && !parseIcon(icon)" class="emoji">{{ icon }}</span>
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
