<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useGame } from '../../core/game';
import SlotCard from './SlotCard.vue';

const game = useGame();
const { Outlet } = game.use('forms');
const settlement = game.use('settlement');
const detail = computed(() => game.view('settlements.detail'));
const districtId = ref('');
const district = computed(() => detail.value?.districts.find((d) => d.id === districtId.value) ?? detail.value?.districts[0]);
watch(
	() => detail.value?.id,
	() => (districtId.value = detail.value?.districts[0]?.id ?? ''),
);

const label = (type: string, idx: number) =>
	type === 'inner' ? game.t('Inner city') : type === 'outer' ? game.t('Outer city {n}', { n: idx }) : game.t('Fortress');
const outerCount = computed(() => detail.value?.districts.filter((d) => d.type === 'outer').length ?? 0);
</script>

<template>
	<section v-if="detail" class="card city">
		<header class="head">
			<div>
				<h2>{{ game.t(detail.name) }}</h2>
				<small>
					{{ game.t(detail.kindName) }} · ({{ detail.x }}, {{ detail.y }}) · {{ game.t('build queue') }} {{ detail.limits.queueUsed }}/{{
						detail.limits.queue
					}}
					<template v-if="detail.districts.some((d) => d.type === 'outer')">
						· {{ game.t('outer cities') }} {{ outerCount }}/{{ detail.limits.outerTech }}</template
					>
					<template v-if="detail.garrison"> · {{ game.t('can garrison troops') }}</template>
				</small>
			</div>
		</header>
		<nav class="districts">
			<button v-for="d in detail.districts" :key="d.id" type="button" :class="{ active: d.id === district?.id }" @click="districtId = d.id">
				{{ label(d.type, d.idx) }} <small>({{ d.slots.length }})</small>
			</button>
		</nav>
		<div v-if="district" class="slots">
			<SlotCard v-for="s in district.slots" :key="s.slot" :settlement="detail.id" :district="district.id" :info="s" />
		</div>
	</section>
	<p v-else-if="settlement.list.value.length === 0" class="muted">{{ game.t('You have no settlement yet') }}</p>
	<div class="forms">
		<component :is="Outlet" placement="settlement" />
	</div>
</template>

<style scoped>
.city {
	display: grid;
	gap: 12px;
}

.head h2 {
	margin: 0;
	font-size: 1.2rem;
}

.districts {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}

.districts button {
	background: var(--input-bg);
	color: var(--text);
	border: 1px solid var(--border);
}

.districts button.active {
	border-color: var(--accent);
	box-shadow: inset 0 -2px 0 var(--accent);
}

.slots {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
	gap: 10px;
}

.forms {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
	gap: 16px;
	align-items: start;
}
</style>
