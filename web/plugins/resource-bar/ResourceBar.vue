<script setup lang="ts">
import { computed } from 'vue';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

const game = useGame('resource-bar');
const resources = game.use('resources');
const pool = computed(() => game.view('resources.pool'));
const rate = (id: string) => pool.value?.rates[id] ?? 0;
const full = (id: string) => !!pool.value && resources.current(id) >= pool.value.capacity;
const debt = (id: string) => resources.current(id) < 0;
/** Hover text: where the net rate comes from. */
const explain = (id: string, name: string) => {
	const p = pool.value;
	if (!p) return name;
	const parts = [`${game.t(name)}: ${formatNumber(resources.current(id), { decimals: 1 })} / ${game.t('cap')} ${formatNumber(p.capacity)}`];
	if (p.production[id])
		parts.push(
			`${game.t('production')} +${formatNumber(p.production[id], { decimals: 2 })}/s${p.factor !== 1 ? ` × ${formatNumber(p.factor, { decimals: 2 })}` : ''}`,
		);
	if (p.upkeep[id]) parts.push(`${game.t('upkeep')} −${formatNumber(p.upkeep[id], { decimals: 2 })}/s`);
	if (debt(id)) parts.push(`${game.t('in deficit')} (${game.t('limit')} −${formatNumber(p.debtLimit[id] ?? 0)})`);
	return parts.join('\n');
};
</script>

<template>
	<ul v-if="pool" class="resource-bar" :title="`Storage cap: ${formatNumber(pool.capacity)} each`">
		<li v-for="r in game.meta.resources" :key="r.id" :title="explain(r.id, r.name)" :class="{ full: full(r.id), debt: debt(r.id) }">
			<span>{{ r.icon }}</span>
			<span class="amount">{{ formatNumber(resources.current(r.id)) }}</span>
			<small v-if="rate(r.id)" :class="{ negative: rate(r.id) < 0 }"
				>{{ rate(r.id) > 0 ? '+' : '' }}{{ formatNumber(rate(r.id), { decimals: 1 }) }}/s</small
			>
		</li>
		<li class="cap">
			<small>{{ game.t('cap') }} {{ formatNumber(pool.capacity) }}</small>
		</li>
	</ul>
</template>

<style scoped>
.resource-bar {
	list-style: none;
	margin: 0;
	padding: 6px 0;
	display: flex;
	flex-wrap: wrap;
	gap: 8px 20px;
	justify-content: center;
}

li {
	display: flex;
	gap: 6px;
	align-items: baseline;
	font-variant-numeric: tabular-nums;
}

.amount {
	font-weight: 600;
	font-size: 1.05em;
}

.full .amount {
	color: var(--muted);
}

.debt .amount,
.negative {
	color: var(--danger);
}
</style>
