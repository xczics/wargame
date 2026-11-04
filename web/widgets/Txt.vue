<script setup lang="ts">
// A server text as it is drawn: its words, with the icons and costs among them drawn (src/shared/ui.ts `UiVar`; the
// words never hold an icon). Where only text fits (a tooltip, a dropdown's option) `uiText` gives the words alone.
import { computed } from 'vue';
import { costAmount } from '../../src/shared/format';
import type { UiText } from '../../src/shared/ui';
import { useGame } from '../core/game';
import Icon from './Icon.vue';

const props = withDefaults(defineProps<{ text?: UiText; size?: number }>(), { size: 18 });
const game = useGame('widgets');
const parts = computed(() => (props.text ? game.fragments(props.text) : []));
</script>

<template>
	<template v-for="(f, i) in parts" :key="i"
		><template v-if="typeof f === 'string'">{{ f }}</template
		><Icon v-else-if="'icon' in f" class="inline" :icon="f.icon" :size="size" /><template v-else
			><span v-for="(c, j) in f.cost" :key="j" class="cost"
				><Icon v-if="c.icon" class="inline" :icon="c.icon" :size="size" /><template v-else>{{ game.t(c.name) }} </template
				>{{ costAmount(c.amount, f) }}</span
			></template
		></template
	>
</template>

<style scoped>
.inline {
	margin: 0 1px;
	vertical-align: -0.2em;
}
.cost + .cost {
	margin-left: 0.4em;
}
</style>
