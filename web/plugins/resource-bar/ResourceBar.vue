<script setup lang="ts">
import { computed, ref } from 'vue';
import { breakdownTexts, partTexts } from '../../../src/shared/stats';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

const game = useGame('resource-bar');
const resources = game.use('resources');
const pool = computed(() => game.view('resources.pool'));
// Every resource's amount now, once a tick (the clock ticks ten times a second), not once per use in the template.
const now = computed(() => Object.fromEntries((game.meta.resources ?? []).map((r) => [r.id, resources.current(r.id)])));
const amount = (id: string) => now.value[id] ?? 0;
const rate = (id: string) => pool.value?.rates[id] ?? 0;
const full = (id: string) => !!pool.value && amount(id) >= pool.value.capacity;
const debt = (id: string) => amount(id) < 0;
/** Where the net rate comes from, by resource: what changes with the pool only (not with the clock). */
const sources = computed(() => {
	const p = pool.value;
	const out: Record<string, string[]> = {};
	if (!p) return out;
	for (const r of game.meta.resources ?? []) {
		const id = r.id;
		const parts: string[] = [];
		if (p.production[id]) {
			const made = formatNumber(p.production[id], { decimals: 2 });
			parts.push(
				p.factor !== 1
					? game.t('Production +{0}/s × {1}', { 0: made, 1: formatNumber(p.factor, { decimals: 2 }) })
					: game.t('Production +{0}/s', { 0: made }),
				// The factor by source ("Heroes on duty +12%"), indented under the production.
				...partTexts(p.factorParts, { flatAsPercent: true }).map((t) => `  ${game.t(t)}`),
			);
		}
		// Bonuses of this resource or district alone (terrain, irrigation...): on top of the general factor.
		if (p.extra[id])
			parts.push(game.t('Bonus {0}{1}/s', { 0: p.extra[id] > 0 ? '+' : '−', 1: formatNumber(Math.abs(p.extra[id]), { decimals: 2 }) }));
		if (p.upkeep[id]) parts.push(game.t('Upkeep −{0}/s', { 0: formatNumber(p.upkeep[id], { decimals: 2 }) }));
		out[id] = parts;
	}
	return out;
});
// The hover text only for the resource under the pointer (worked out every tick while it is there, never for the others).
const hovered = ref<string | null>(null);
const explain = (id: string, name: string) => {
	const p = pool.value;
	if (!p) return name;
	return [
		game.t('{0}: {1} / cap {2}', { 0: game.t(name), 1: formatNumber(amount(id), { decimals: 1 }), 2: formatNumber(p.capacity) }),
		...(sources.value[id] ?? []),
		...(debt(id) ? [game.t('In deficit (limit −{0})', { 0: formatNumber(p.debtLimit[id] ?? 0) })] : []),
	].join('\n');
};
</script>

<template>
	<ul v-if="pool" class="resource-bar">
		<li
			v-for="r in game.meta.resources"
			:key="r.id"
			:title="hovered === r.id ? explain(r.id, r.name) : undefined"
			:class="{ full: full(r.id), debt: debt(r.id) }"
			@mouseenter="hovered = r.id"
			@mouseleave="hovered = null"
		>
			<span>{{ r.icon }}</span>
			<span class="amount">{{ formatNumber(amount(r.id)) }}</span>
			<!-- At the cap production stops: no growth to show. -->
			<small v-if="rate(r.id) > 0 && full(r.id)" class="negative">{{ game.t('full') }}</small>
			<small v-else-if="rate(r.id)" :class="{ negative: rate(r.id) < 0 }"
				>{{ rate(r.id) > 0 ? '+' : '' }}{{ formatNumber(rate(r.id), { decimals: Math.abs(rate(r.id)) < 10 ? 2 : 1 }) }}/s</small
			>
		</li>
		<li
			class="cap"
			:title="
				breakdownTexts(pool.capacityBreakdown)
					.map((t) => game.t(t))
					.join('\n')
			"
		>
			<small>{{ game.t('Cap {0}', { 0: formatNumber(pool.capacity) }) }}</small>
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
