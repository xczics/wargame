<script setup lang="ts">
// Troops stationed in every settlement of the player, with strength, upkeep and training.
import { computed } from 'vue';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

const game = useGame();
const settlement = game.use('settlement');
const garrisons = computed(() => game.view('troops.overview') ?? []);
const units = new Map((game.meta.units ?? []).map((u) => [u.id, u]));
const numbers = computed(() => new Map((game.view('troops.units') ?? []).map((u) => [u.id, u])));
const icons = new Map((game.meta.resources ?? []).map((r) => [r.id, r.icon ?? r.id]));
const n = (v: number | undefined) => formatNumber(v ?? 0, { decimals: 1 });
const name = (id: string) => game.t(settlement.list.value.find((s) => s.id === id)?.name ?? id);
const left = (t: number) => {
	const s = Math.max(0, Math.ceil((t - game.serverNow()) / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
</script>

<template>
	<section class="card">
		<h2>{{ game.t('Garrisons') }}</h2>
		<div v-for="g in garrisons" :key="g.settlement" class="garrison" :class="{ current: g.settlement === settlement.current.value?.id }">
			<h3>
				<button type="button" class="link" @click="settlement.select(g.settlement)">{{ name(g.settlement) }}</button>
			</h3>
			<p v-if="!g.units.length" class="muted">
				<small>{{ game.t('No troops stationed here.') }}</small>
			</p>
			<ul v-else class="units">
				<li v-for="u in g.units" :key="u.id">
					<span>{{ units.get(u.id)?.icon }}</span>
					<span>{{ game.t(units.get(u.id)?.name ?? u.id) }}</span>
					<strong class="count">×{{ formatNumber(u.count) }}</strong>
					<small class="muted"
						>{{ game.t('atk') }} {{ n(numbers.get(u.id)?.attack) }} · {{ game.t('def') }} {{ n(numbers.get(u.id)?.defense) }} ·
						{{ game.t('hp') }} {{ n(numbers.get(u.id)?.hp) }}</small
					>
				</li>
			</ul>
			<small v-if="g.units.length">
				{{ game.t('Strength') }}: {{ game.t('attack') }} {{ formatNumber(g.power.attack) }} · {{ game.t('defense') }}
				{{ formatNumber(g.power.defense) }} · {{ game.t('hp') }} {{ formatNumber(g.power.hp) }}
			</small>
			<small v-if="Object.keys(g.upkeep).length" class="muted">
				{{ game.t('Upkeep') }}:
				<span v-for="(v, r) in g.upkeep" :key="r" class="part"
					>{{ icons.get(String(r)) }} −{{ formatNumber(v * 3600, { decimals: 1 }) }}/h</span
				>
			</small>
			<small v-if="g.training" class="muted">
				{{ game.t('Training') }} {{ game.t(units.get(g.training.unit)?.name ?? '') }} ×{{ g.training.count }} ·
				{{ left(g.training.finishesAt) }}
			</small>
		</div>
		<p class="muted">
			<small>{{ game.t('Train troops in the barracks (open the building on the Overview page).') }}</small>
		</p>
		<p class="muted">
			<small>{{ game.t('— if a resource runs out, troops that need it leave (or drop a tier) bit by bit until upkeep fits.') }}</small>
		</p>
	</section>
</template>

<style scoped>
.garrison {
	display: grid;
	gap: 4px;
	padding: 8px 0;
	border-top: 1px solid var(--border);
}

.garrison.current h3 button {
	color: var(--accent);
}

h3 {
	margin: 0;
	font-size: 1em;
}

.units {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 4px;
}

.units li {
	display: flex;
	gap: 6px;
	align-items: baseline;
	flex-wrap: wrap;
}

.count {
	font-variant-numeric: tabular-nums;
}

.part + .part {
	margin-left: 6px;
}
</style>
