<script setup lang="ts">
// Order of the heroes defending the selected settlement (from those attached to it).
import { computed, ref, watch } from 'vue';
import { useGame } from '../../core/game';

const game = useGame();
const heroes = game.use('heroes');
const settlement = game.use('settlement');
const attached = computed(() => (game.view('heroes.list') ?? []).filter((h) => h.home === settlement.current.value?.id));
const saved = computed(() => game.view('heroes.defense')?.order ?? null);
const order = ref<string[]>([]);
// Start from the saved order (known heroes first), then everyone else attached here.
watch(
	[saved, attached],
	() => {
		const ids = attached.value.map((h) => h.id);
		order.value = [...(saved.value ?? []).filter((id) => ids.includes(id)), ...ids.filter((id) => !(saved.value ?? []).includes(id))];
	},
	{ immediate: true },
);
const byId = computed(() => new Map(attached.value.map((h) => [h.id, h])));
const swap = (i: number, j: number) => {
	const next = [...order.value];
	[next[i], next[j]] = [next[j], next[i]];
	order.value = next;
};
const save = (ids: string[]) => game.command('heroes.setDefenseOrder', { settlement: settlement.current.value!.id, heroes: ids });
</script>

<template>
	<section class="card">
		<h2>{{ game.t('Defence order') }}</h2>
		<p class="muted">{{ game.t('The first heroes here that are in town defend this settlement; the rest are substitutes.') }}</p>
		<p v-if="!attached.length" class="muted">{{ game.t('No heroes attached here.') }}</p>
		<template v-else>
			<small v-if="!saved" class="muted">{{ game.t('Strongest first (not set).') }}</small>
			<ol class="order">
				<li v-for="(id, i) in order" :key="id">
					<span>{{ heroes.name(byId.get(id)!) }}</span>
					<button type="button" class="link" :disabled="i === 0" @click="swap(i, i - 1)">↑</button>
					<button type="button" class="link" :disabled="i === order.length - 1" @click="swap(i, i + 1)">↓</button>
				</li>
			</ol>
			<div class="row">
				<button type="button" class="small" @click="save(order)">{{ game.t('Save') }}</button>
				<button v-if="saved" type="button" class="small secondary" @click="save([])">{{ game.t('Reset') }}</button>
			</div>
		</template>
	</section>
</template>

<style scoped>
.order {
	margin: 8px 0;
	padding-left: 20px;
	display: grid;
	gap: 4px;
}

.order li span {
	margin-right: 8px;
}

.row {
	display: flex;
	gap: 8px;
}
</style>
