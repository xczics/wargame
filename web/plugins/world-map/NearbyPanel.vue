<script setup lang="ts">
// Overview next to the map: NPC settlements within a few tiles of the map's centre, nearest
// first. Picking one moves the map there (and the overview with it).
import { computed, ref, watch } from 'vue';
import type { ClientState, NearbyOverview } from '../../../src/shared/api';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

const props = defineProps<{ centre: { x: number; y: number } }>();
const emit = defineEmits<{ pick: [tile: { x: number; y: number }] }>();
const game = useGame();
const settlement = game.use('settlement');
const radius = ref(20);
const overview = ref<NearbyOverview | null>(null);
const list = computed(() => overview.value?.settlements ?? null);
// Steps up to the GM's limit, and the limit itself.
const radii = computed(() => {
	const max = overview.value?.maxRadius ?? 50;
	return [...new Set([...[10, 20, 30, 50, 100, 200].filter((r) => r < max), max])];
});

async function load() {
	const q = new URLSearchParams({
		views: 'settlements.nearby',
		x: String(props.centre.x),
		y: String(props.centre.y),
		r: String(radius.value),
		npc: '1',
	});
	overview.value = (await game.request<ClientState>(`/api/state?${q}`)).views['settlements.nearby'] as NearbyOverview;
	if (radius.value > overview.value.maxRadius) radius.value = overview.value.maxRadius;
}
watch([() => props.centre, radius], load, { immediate: true });
</script>

<template>
	<aside class="nearby">
		<div class="head">
			<strong>{{ game.t('NPC settlements nearby') }}</strong>
			<label>
				<small class="muted">{{ game.t('Within') }}</small>
				<select v-model.number="radius">
					<option v-for="r in radii" :key="r" :value="r">{{ game.t('{n} tiles', { n: r }) }}</option>
				</select>
			</label>
		</div>
		<small class="muted">{{ game.t('Around the centre of the map ({x}, {y}).', { x: centre.x, y: centre.y }) }}</small>
		<p v-if="list && !list.length" class="muted">{{ game.t('None.') }}</p>
		<ul v-else-if="list">
			<li v-for="s in list" :key="s.settlement">
				<button type="button" class="item" @click="emit('pick', { x: s.x, y: s.y })">
					<span>☠️ {{ game.t('{name} ({kind})', { name: game.t(s.name), kind: settlement.kindName(s.kind) }) }}</span>
					<small class="muted">({{ s.x }}, {{ s.y }})</small>
					<small class="distance">{{ game.t('{n} tiles', { n: formatNumber(s.distance, { decimals: 1 }) }) }}</small>
				</button>
			</li>
		</ul>
	</aside>
</template>

<style scoped>
.nearby {
	flex: 1 1 240px;
	min-width: 0;
	display: grid;
	gap: 6px;
	align-content: start;
}

.head {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 8px;
}

.head select {
	width: auto;
	padding: 2px 6px;
}

ul {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 4px;
	max-height: 520px;
	overflow-y: auto;
}

.item {
	width: 100%;
	display: flex;
	gap: 8px;
	align-items: baseline;
	text-align: left;
	background: none;
	color: inherit;
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 4px 8px;
}

.distance {
	margin-left: auto;
	font-variant-numeric: tabular-nums;
}
</style>
