<script setup lang="ts">
// Offers grouped by category; the price turns red when the balance is short.
import { computed } from 'vue';
import type { ShopOffer } from '../../../src/shared/api';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

const game = useGame();
const store = computed(() => game.view('shop.store'));
const groups = computed(() => {
	const out = new Map<string, ShopOffer[]>();
	for (const o of store.value?.offers ?? []) out.set(o.category, [...(out.get(o.category) ?? []), o]);
	return [...out];
});
const limited = (o: ShopOffer) => !!o.dailyLimit && o.boughtToday >= o.dailyLimit;
const buy = (o: ShopOffer) => game.command('shop.buy', { offer: o.id });
</script>

<template>
	<section v-if="store" class="card">
		<h2>
			{{ game.t('Shop') }} <small class="balance">💰 {{ game.t('{n} yuanbao', { n: formatNumber(store.balance) }) }}</small>
		</h2>
		<small class="muted">{{ game.t('Bought items go to your inventory; use them on the Items page.') }}</small>
		<div v-for="[category, offers] in groups" :key="category" class="group">
			<h3>{{ game.t(`shop:${category}`) }}</h3>
			<ul class="offers">
				<li v-for="o in offers" :key="o.id">
					<strong
						>{{ o.icon }} {{ game.t(o.name) }}<template v-if="o.count > 1"> {{ game.t('×{n}', { n: o.count }) }}</template></strong
					>
					<small v-if="o.description" class="muted">{{ game.t(o.description) }}</small>
					<div class="row">
						<span :class="{ short: store.balance < o.price }">💰 {{ formatNumber(o.price) }}</span>
						<small v-if="o.dailyLimit" class="muted">{{ game.t('today {n} / {limit}', { n: o.boughtToday, limit: o.dailyLimit }) }}</small>
						<button type="button" class="small" :disabled="store.balance < o.price || limited(o)" @click="buy(o)">
							{{ game.t('Buy') }}
						</button>
					</div>
				</li>
			</ul>
		</div>
	</section>
</template>

<style scoped>
.balance {
	font-weight: normal;
	margin-left: 8px;
}

.group h3 {
	margin: 14px 0 6px;
}

.offers {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
	gap: 10px;
}

.offers li {
	display: grid;
	gap: 4px;
	padding: 10px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
	align-content: space-between;
}

.row {
	display: flex;
	gap: 8px;
	align-items: center;
	flex-wrap: wrap;
}

.short {
	color: var(--danger);
}
</style>
