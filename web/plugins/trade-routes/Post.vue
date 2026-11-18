<script setup lang="ts">
// A trade post's entry (docs/design/gameplay.md §17.3): the trade orders the player's routes have opened, each once a
// day, priced by the resources' values plus the loss (less with every point the routes give); the deal under way here.
// Its level is the building's (the slot level the city page holds); the server checks the order, the price and the post.
import { computed, watchEffect } from 'vue';
import { duration } from '../../../src/shared/format';
import { asText, costVar } from '../../../src/shared/i18n';
import { type TradeRoutesStatic, tradeLoss, tradePrice, tradeSeconds, tradeSpeed } from '../../../src/shared/trade-routes';
import { type Entry, useGame } from '../../core/game';
import Line from '../../widgets/Line.vue';
import Txt from '../../widgets/Txt.vue';
import { cleared } from './plan';

const props = defineProps<{ entry: Entry }>();
const game = useGame('trade-routes');
const routes = computed(() => game.static<TradeRoutesStatic>('trade-routes.routes'));
const state = computed(() => game.view('trade-routes.state'));
const settlement = computed(() => props.entry.data?.settlement ?? '');
const level = computed(() => game.counter(`slot-level:${props.entry.id}`) ?? 0);

const orders = computed(() =>
	(routes.value?.routes ?? []).flatMap((r) =>
		r.nodes
			.filter((n) => n.unlock && cleared(state.value, r, n.id))
			.flatMap((n) => n.unlock!.orders.map((o) => ({ ...o, route: r, node: n }))),
	),
);
const loss = computed(() => (routes.value ? tradeLoss(routes.value.trade, state.value?.trade.lossPoints ?? 0) : 0));
const price = (o: { from: string; to: string; amount: number }) =>
	routes.value ? tradePrice(o, routes.value.values[o.from] ?? 1, routes.value.values[o.to] ?? 1, loss.value) : 0;
const seconds = computed(() => (routes.value ? tradeSeconds(routes.value.trade, level.value) : 0));
const speed = computed(() => (routes.value ? tradeSpeed(routes.value.trade, level.value) : 0));
const deal = computed(() => state.value?.trade.deals.find((d) => d.settlement === settlement.value) ?? null);
const used = (id: string) => !!state.value?.trade.used.includes(id);
const resources = computed(() => game.meta.resources ?? []);
watchEffect(() => {
	if (deal.value) game.refreshAt(deal.value.finishesAt);
});
const trade = (order: string) => game.command('trade-routes.trade', { settlement: settlement.value, order }, { pending: 'Trading…' });
</script>

<template>
	<section class="post">
		<h4>{{ game.t('Trade') }}</h4>
		<p class="muted">
			{{
				game.t('A deal takes {t} here (trade speed +{s}%) · loss {l}%', {
					t: duration(seconds),
					s: Math.round(speed),
					l: (loss * 100).toFixed(1),
				})
			}}
		</p>
		<Line
			v-if="deal"
			:line="{
				icon: resources.find((r) => r.id === deal!.resource)?.icon,
				text: asText(costVar({ [deal.resource]: deal.amount }, resources)),
				startedAt: deal.startedAt,
				endsAt: deal.finishesAt,
			}"
		/>
		<p v-if="!orders.length" class="muted">{{ game.t('No trade orders yet: clear the key places on the trade routes.') }}</p>
		<ul v-else>
			<li v-for="o in orders" :key="o.id">
				<span>
					<Txt :text="asText(costVar({ [o.to]: o.amount }, resources))" />
					{{ game.t('for') }}
					<Txt :text="asText(costVar({ [o.from]: price(o) }, resources))" />
					<small class="muted"> · {{ o.node.name ? game.t(o.node.name) : o.node.id }}</small>
				</span>
				<button type="button" :disabled="used(o.id) || !!deal || level < 1" @click="trade(o.id)">
					{{ used(o.id) ? game.t('Done today') : game.t('Trade') }}
				</button>
			</li>
		</ul>
	</section>
</template>

<style scoped>
.post {
	display: grid;
	gap: 6px;
}

.post h4,
.post p {
	margin: 0;
}

ul {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 6px;
}

li {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	justify-content: space-between;
	align-items: center;
}
</style>
