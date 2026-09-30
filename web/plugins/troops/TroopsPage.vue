<script setup lang="ts">
import { computed } from 'vue';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

const game = useGame();
const { Outlet } = game.use('forms');
const settlement = game.use('settlement');
const g = computed(() => game.view('troops.garrison'));
const units = new Map((game.meta.units ?? []).map((u) => [u.id, u]));
const icons = new Map((game.meta.resources ?? []).map((r) => [r.id, r.icon ?? r.id]));
const remaining = computed(() => (g.value?.training ? Math.max(0, Math.ceil((g.value.training.finishesAt - game.serverNow()) / 1000)) : 0));
const progress = computed(() => {
	const t = g.value?.training;
	return t ? Math.min(100, ((game.serverNow() - t.startedAt) / (t.finishesAt - t.startedAt)) * 100) : 0;
});
</script>

<template>
	<section v-if="g" class="card troops">
		<h2>{{ game.t('Troops') }} · {{ game.t(settlement.current.value?.name ?? '') }}</h2>
		<p v-if="!g.allowed" class="muted">{{ game.t('This kind of settlement cannot hold troops.') }}</p>
		<template v-else>
			<p v-if="!g.units.length" class="muted">{{ game.t('No troops stationed here.') }}</p>
			<ul v-else class="units">
				<li v-for="u in g.units" :key="u.id">
					<span class="icon">{{ units.get(u.id)?.icon }}</span>
					<strong>{{ game.t(units.get(u.id)?.name ?? u.id) }}</strong>
					<span class="count">×{{ formatNumber(u.count) }}</span>
					<small class="muted"
						>{{ game.t('atk') }} {{ units.get(u.id)?.attack }} · {{ game.t('def') }} {{ units.get(u.id)?.defense }}</small
					>
				</li>
			</ul>
			<small v-if="g.units.length">
				{{ game.t('Strength') }}: {{ game.t('attack') }} {{ formatNumber(g.power.attack) }} · {{ game.t('defense') }}
				{{ formatNumber(g.power.defense) }}
				<span v-for="f in g.power.factors" :key="f.source" :class="{ bad: f.attack < 1 || f.defense < 1 }">
					· {{ game.t(f.source) }} (×{{ formatNumber(f.attack, { decimals: 2 }) }}/×{{ formatNumber(f.defense, { decimals: 2 }) }})
				</span>
			</small>
			<small v-if="Object.keys(g.upkeep).length" class="muted">
				{{ game.t('Upkeep') }}:
				<span v-for="(n, r) in g.upkeep" :key="r" class="part">{{ icons.get(String(r)) }} −{{ formatNumber(n, { decimals: 2 }) }}/s</span>
				{{ game.t('— if a resource runs out, troops that need it desert.') }}
			</small>
			<div v-if="g.training" class="training">
				<small
					>{{ game.t('Training') }} {{ game.t(units.get(g.training.unit)?.name ?? '') }} ×{{ g.training.count }} · {{ remaining }}s</small
				>
				<div class="bar"><div :style="{ width: `${progress}%` }"></div></div>
			</div>
			<small v-else-if="g.trainable.every((t) => t.blocked)" class="muted">{{ game.t(g.trainable[0]?.blocked ?? '') }}</small>
		</template>
	</section>
	<div class="forms">
		<component :is="Outlet" placement="troops" />
	</div>
</template>

<style scoped>
.troops {
	display: grid;
	gap: 10px;
}

.units {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 6px;
}

.units li {
	display: flex;
	gap: 8px;
	align-items: baseline;
}

.icon {
	font-size: 1.3em;
}

.count {
	font-variant-numeric: tabular-nums;
	font-weight: 600;
}

.bad {
	color: var(--danger);
}

.part + .part {
	margin-left: 6px;
}

.bar {
	height: 6px;
	border-radius: 3px;
	background: var(--border);
	overflow: hidden;
}

.bar div {
	height: 100%;
	background: var(--accent);
}

.forms {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
	gap: 16px;
}
</style>
