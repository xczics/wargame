<script setup lang="ts">
// A trade post's entry (docs/design/gameplay.md §17.3). The orders the player's routes opened, added up by direction, are
// today's quota that way (user 2026-11-25: "把这些商单全部加起来，作为每日上限，玩家可以自由选择数量"): the player
// picks how much; each deal is its own timer, several side by side at a post ("可以并行N个队列"; "最低3，每三级多一个").
// Priced by the resources' values plus the loss (less with every point the routes give). Its level is the building's
// (the slot level the city page holds); the server checks the quota, the price and the post.
// Teams set out from here too (Depart; user 2026-11-20: "把派出表单整体挪到商路开拓的建筑页面"), once it is built; one
// out already is shown as such (one team at a time).
import { computed, reactive, ref, watchEffect } from 'vue';
import { duration, whole } from '../../../src/shared/format';
import { asText, costVar } from '../../../src/shared/i18n';
import {
	type TradeRoutesStatic,
	tradeLoss,
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
// What to sell and what to buy (user 2026-11-25: "C_5^2 *2 会很大……建议增加两行按钮，第一行是卖xx, 第二行是买xx.
// 筛选同时作用于玩家可填的表单，和下方展示来源的列表"): null = any.
const sell = ref<string | null>(null);
const buy = ref<string | null>(null);
const sells = computed(() => [...new Set(orders.value.map((o) => o.from))]);
const buys = computed(() => [...new Set(orders.value.map((o) => o.to))]);
const shown = computed(() => orders.value.filter((o) => (!sell.value || o.from === sell.value) && (!buy.value || o.to === buy.value)));
/** One row a direction: its quota (the orders that way, added up) and what is left of it today. */
const directions = computed(() =>
	Object.entries(tradeQuotas(shown.value)).map(([pair, quota]) => {
		const [from, to] = pair.split('>');
		return { pair, from, to, quota, left: Math.max(0, quota - (state.value?.trade.traded[pair] ?? 0)) };
	}),
);
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
		<p v-if="!orders.length" class="muted">{{ game.t('No trade orders yet: clear the key places on the trade routes.') }}</p>
		<template v-else>
			<div class="filter">
				<span class="muted">{{ game.t('Sell:') }}</span>
				<button type="button" class="small" :class="{ secondary: sell !== null }" @click="sell = null">{{ game.t('All') }}</button>
				<button v-for="r in sells" :key="r" type="button" class="small" :class="{ secondary: sell !== r }" @click="sell = r">
					<Icon :icon="resource(r)?.icon" :size="14" />{{ game.t(resource(r)?.name ?? r) }}
				</button>
			</div>
			<div class="filter">
				<span class="muted">{{ game.t('Buy:') }}</span>
				<button type="button" class="small" :class="{ secondary: buy !== null }" @click="buy = null">{{ game.t('All') }}</button>
				<button v-for="r in buys" :key="r" type="button" class="small" :class="{ secondary: buy !== r }" @click="buy = r">
					<Icon :icon="resource(r)?.icon" :size="14" />{{ game.t(resource(r)?.name ?? r) }}
				</button>
			</div>
			<p v-if="!directions.length" class="muted">{{ game.t('No trade orders this way.') }}</p>
		</template>
		<ul v-if="directions.length" class="ways">
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
		<template v-if="shown.length">
			<h5>{{ game.t('Trade orders') }}</h5>
			<ul class="orders">
				<li v-for="o in shown" :key="o.id">
					<span>
						{{ game.t('Pay') }}
						<Txt :text="asText(costVar({ [o.from]: price(o.from, o.to, o.amount) }, resources))" />
						{{ game.t(', get') }}
						<Txt :text="asText(costVar({ [o.to]: o.amount }, resources))" />
						{{ game.t('a day') }}
					</span>
					<small class="muted">{{ o.where }}</small>
				</li>
			</ul>
		</template>
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

.ways li {
	display: grid;
	gap: 4px;
}

.orders li {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	justify-content: space-between;
	align-items: center;
}

.filter {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	align-items: center;
}

.post h5 {
	margin: 6px 0 0;
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
