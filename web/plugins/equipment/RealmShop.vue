<script setup lang="ts">
// The realm shop (Realms page, left): white pieces of the realms the player has opened, for
// currency; bought pieces go to the selected settlement's storage.
import { computed } from 'vue';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

const game = useGame();
const settlement = game.use('settlement');
const resources = game.use('resources');
const shop = computed(() => game.view('starter-equipment.shop'));
const icons = new Map((game.meta.resources ?? []).map((r) => [r.id, r.icon ?? r.id]));
const cost = (c: Record<string, number>) =>
	Object.entries(c)
		.map(([r, n]) => `${icons.get(r) ?? r}${formatNumber(n)}`)
		.join(' ');
const buy = (base: string) => game.command('starter-equipment.buy', { base, settlement: settlement.current.value?.id ?? '' });
</script>

<template>
	<section v-if="shop?.offers.length" class="card">
		<h2>{{ game.t('Realm shop') }}</h2>
		<small class="muted">{{ game.t('White pieces of the realms you have opened. Other colours only drop on adventures.') }}</small>
		<ul class="offers">
			<li v-for="o in shop.offers" :key="o.base">
				<span class="rarity rarity-white">{{ o.icon }} {{ game.t(o.name) }}</span>
				<small class="muted">{{ game.t(o.set) }} · {{ game.t('Lv {n}', { n: o.minLevel }) }}</small>
				<button type="button" class="small" :disabled="!resources.canAfford(o.cost)" @click="buy(o.base)">{{ cost(o.cost) }}</button>
			</li>
		</ul>
	</section>
</template>

<style scoped>
.offers {
	list-style: none;
	margin: 8px 0 0;
	padding: 0;
	display: grid;
	gap: 6px;
}

.offers li {
	display: grid;
	grid-template-columns: 1fr auto;
	gap: 2px 8px;
	align-items: center;
}

.offers li small {
	grid-column: 1;
}

.offers li button {
	grid-column: 2;
	grid-row: 1 / 3;
}
</style>
