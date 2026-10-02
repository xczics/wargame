<script setup lang="ts">
// Left column of the Items page: filter by category (how many of each kind are owned).
import { computed } from 'vue';
import { useGame } from '../../core/game';
import { category, picked } from './state';

const game = useGame();
const items = computed(() => game.view('items.inventory') ?? []);
const categories = computed(() => {
	const out = new Map<string, number>();
	for (const i of items.value) out.set(i.category, (out.get(i.category) ?? 0) + 1);
	return [...out];
});
function choose(c: string | null) {
	category.value = c;
	picked.value = null;
}
</script>

<template>
	<section class="card">
		<h2>{{ game.t('Items') }}</h2>
		<div class="cats">
			<button type="button" class="small" :class="{ secondary: category !== null }" @click="choose(null)">
				{{ game.t('All') }} <small>({{ items.length }})</small>
			</button>
			<button v-for="[c, n] in categories" :key="c" type="button" class="small" :class="{ secondary: category !== c }" @click="choose(c)">
				{{ game.t(`item-category:${c}`) }} <small>({{ n }})</small>
			</button>
		</div>
	</section>
</template>

<style scoped>
.cats {
	display: grid;
	gap: 6px;
}
</style>
