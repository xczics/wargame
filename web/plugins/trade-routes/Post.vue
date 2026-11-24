<script setup lang="ts">
// A trade post's entry (docs/design/gameplay.md §17.3). The orders the player's routes opened, added up by direction, are
// today's quota that way (user 2026-11-25: "把这些商单全部加起来，作为每日上限，玩家可以自由选择数量"): the player
// picks how much; each deal is its own timer, several side by side at a post ("可以并行N个队列"; "最低3，每三级多一个").
// Priced by the resources' values plus the loss (less with every point the routes give). Its level is the building's
// (the slot level the city page holds); the server checks the quota, the price and the post.
// Teams set out from here too (Depart; user 2026-11-20: "把派出表单整体挪到商路开拓的建筑页面"), once it is built; one
// out already is shown as such (one team at a time).
import { computed, reactive, watchEffect } from 'vue';
import { duration, whole } from '../../../src/shared/format';
import { asText, costVar } from '../../../src/shared/i18n';
import {
	type TradeRoutesStatic,
	tradeLoss,
	tradePair,
	tradePrice,
	tradeQueues,
	tradeQuotas,
	tradeSeconds,
	tradeSpeed,
} from '../../../src/shared/trade-routes';
import { type Entry, useGame } from '../../core/game';
import Icon from '../../widgets/Icon.vue';
import Line from '../../widgets/Line.vue';
import Txt from '../../widgets/Txt.vue';
import Depart from './Depart.vue';
import { cleared } from './plan';
import { postLevels } from './post-levels';

const props = defineProps<{ entry: Entry }>();
const game = useGame('trade-routes');
const routes = computed(() => game.static<TradeRoutesStatic>('trade-routes.routes'));
const state = computed(() => game.view('trade-routes.state'));
const settlement = computed(() => props.entry.data?.settlement ?? '');
const level = computed(() => game.counter(`slot-level:${props.entry.id}`) ?? 0);
// For the command's answer (commands.ts): how long the deal sent from here takes.
watchEffect(() => {
	if (settlement.value && level.value) postLevels.set(settlement.value, level.value);
});

// Those the routes' key places opened, and those drops in fights opened for good (no place: "won in a fight").
const orders = computed(() => [
	...(routes.value?.routes ?? []).flatMap((r) =>
		r.nodes
			.filter((n) => n.unlock && cleared(state.value, r, n.id))
			.flatMap((n) => n.unlock!.orders.map((o) => ({ ...o, where: n.name ? game.t(n.name) : n.id }))),
	),
	...(routes.value?.orders ?? [])
		.filter((o) => state.value?.trade.unlocked.includes(o.id))
		.map((o) => ({ ...o, where: game.t('won in a fight') })),
]);
/** One row a direction: its quota (the orders that way, added up), what is left of it today, where the orders came from. */
const directions = computed(() => {
	const quotas = tradeQuotas(orders.value);
	return Object.entries(quotas).map(([pair, quota]) => {
		const [from, to] = pair.split('>');
		const these = orders.value.filter((o) => tradePair(o.from, o.to) === pair);
		const where = [...new Set(these.map((o) => o.where))].join(' / ');
		return { pair, from, to, quota, left: Math.max(0, quota - (state.value?.trade.traded[pair] ?? 0)), where };
	});
});
const loss = computed(() => (routes.value ? tradeLoss(routes.value.trade, state.value?.trade.lossPoints ?? 0) : 0));
const price = (from: string, to: string, amount: number) =>
	routes.value ? tradePrice(amount, routes.value.values[from] ?? 1, routes.value.values[to] ?? 1, loss.value) : 0;
const seconds = computed(() => (routes.value ? tradeSeconds(routes.value.trade, level.value) : 0));
const speed = computed(() => (routes.value ? tradeSpeed(routes.value.trade, level.value) : 0));
const queues = computed(() => (routes.value ? tradeQueues(routes.value.trade, level.value) : 0));
const deals = computed(() => {
	void game.elapsed.value; // done ones drop off as they finish
	const now = game.serverNow();
	return (state.value?.trade.deals ?? []).filter((d) => d.settlement === settlement.value && d.finishesAt > now);
});
const resources = computed(() => game.meta.resources ?? []);
const resource = (id: string) => resources.value.find((r) => r.id === id);
watchEffect(() => {
	for (const d of deals.value) game.refreshAt(d.finishesAt);
});
const out = computed(() => state.value?.expedition ?? null);
const outOn = computed(() => {
	const r = routes.value?.routes.find((x) => x.id === out.value?.route);
	return r ? game.t(r.name) : '';
});

// How much to buy each way: what is left of today's quota unless the player typed less.
const typed = reactive<Record<string, number | ''>>({});
const amountOf = (d: { pair: string; left: number }) => {
	const n = typed[d.pair];
	return typeof n === 'number' && n > 0 ? Math.min(Math.floor(n), d.left) : d.left;
};
const trade = async (d: { pair: string; from: string; to: string; left: number }) => {
	const amount = amountOf(d);
	if (amount < 1) return;
	const ok = await game.command(
		'trade-routes.trade',
		{ settlement: settlement.value, from: d.from, to: d.to, amount },
		{ pending: 'Trading…' },
	);
	if (ok) delete typed[d.pair];
};
</script>

<template>
	<section class="post">
		<template v-if="routes && level >= 1">
			<p v-if="out" class="muted">{{ game.t('The team is out on {route}: see the Trade Routes page.', { route: outOn }) }}</p>
			<Depart v-else :routes="routes" :settlement="settlement" />
		</template>
		<h4>{{ game.t('Trade') }}</h4>
		<p class="muted">
			{{
				game.t('A deal takes {t} here (trade speed +{s}%) · loss {l}% · deals at once {n} / {q}', {
					t: duration(seconds),
					s: Math.round(speed),
					l: (loss * 100).toFixed(1),
					n: deals.length,
					q: queues,
				})
			}}
		</p>
		<Line
			v-for="d in deals"
			:key="d.id"
			:line="{
				icon: resource(d.resource)?.icon,
				text: asText(costVar({ [d.resource]: d.amount }, resources)),
				startedAt: d.startedAt,
				endsAt: d.finishesAt,
			}"
		/>
		<p v-if="!directions.length" class="muted">{{ game.t('No trade orders yet: clear the key places on the trade routes.') }}</p>
		<ul v-else>
			<li v-for="d in directions" :key="d.pair">
				<div class="way">
					<span>
						<Icon :icon="resource(d.from)?.icon" :size="16" />{{ game.t(resource(d.from)?.name ?? d.from) }} →
						<Icon :icon="resource(d.to)?.icon" :size="16" />{{ game.t(resource(d.to)?.name ?? d.to) }}
					</span>
					<small class="muted">
						{{
							game.t('{to} left today: {left} / {quota}', {
								to: game.t(resource(d.to)?.name ?? d.to),
								left: whole(d.left),
								quota: whole(d.quota),
							})
						}}
						·
						{{ d.where }}
					</small>
				</div>
				<div class="deal">
					<label>
						{{ game.t('Get') }}
						<input v-model.number="typed[d.pair]" type="number" min="1" :max="d.left" :placeholder="String(d.left)" :disabled="!d.left" />
					</label>
					<span>
						{{ game.t('pay') }}
						<Txt :text="asText(costVar({ [d.from]: price(d.from, d.to, amountOf(d)) }, resources))" />
					</span>
					<button type="button" :disabled="!d.left || deals.length >= queues || level < 1" @click="trade(d)">
						{{ d.left ? game.t('Trade') : game.t('Quota used up today') }}
					</button>
				</div>
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
	display: grid;
	gap: 4px;
}

.way,
.deal {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	align-items: center;
}

.way {
	justify-content: space-between;
}

.deal button {
	margin-left: auto;
}

.deal input {
	width: 7em;
}
</style>
