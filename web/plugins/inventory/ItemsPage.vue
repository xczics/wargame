<script setup lang="ts">
// Right column of the Items page: a grid of the owned items (of the chosen category); opening one
// shows its description and use form, with a way back to the grid.
import { computed, watch } from 'vue';
import { useGame } from '../../core/game';
import { category, picked } from './state';

const game = useGame();
const { Outlet } = game.use('forms');
const settlement = game.use('settlement');
const items = computed(() => game.view('items.inventory') ?? []);
const shown = computed(() => items.value.filter((i) => category.value === null || i.category === category.value));
const item = computed(() => items.value.find((i) => i.id === picked.value));
// Used up: back to the grid.
watch(items, () => {
	if (picked.value && !item.value) picked.value = null;
});
</script>

<template>
	<section v-if="item" class="card detail">
		<div class="head">
			<h2>
				{{ item.icon }} {{ game.t(item.name) }} <small class="muted">×{{ item.count }}</small>
			</h2>
			<button type="button" class="small secondary" @click="picked = null">{{ game.t('Back') }}</button>
		</div>
		<p>{{ game.t(item.description ?? '') }}</p>
		<small v-if="item.usable" class="muted">{{
			game.t('Usable items apply to the selected settlement: {name}.', { name: game.t(settlement.current.value?.name ?? '') })
		}}</small>
		<small v-else class="muted">{{ game.t('This item is not used from here.') }}</small>
		<div v-if="item.usable" class="forms">
			<component :is="Outlet" placement="items" :only="[`items.use.${item.id}`]" />
		</div>
	</section>
	<section v-else class="card">
		<h2>{{ game.t(category ? `item-category:${category}` : 'All items') }}</h2>
		<p v-if="!shown.length" class="muted">{{ game.t('Your inventory is empty.') }}</p>
		<ul v-else class="grid">
			<li v-for="i in shown" :key="i.id">
				<button type="button" class="tile" :title="game.t(i.description ?? '')" @click="picked = i.id">
					<span class="icon">{{ i.icon }}</span>
					<span class="name">{{ game.t(i.name) }}</span>
					<small class="count">×{{ i.count }}</small>
				</button>
			</li>
		</ul>
	</section>
</template>

<style scoped>
.head {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	gap: 8px;
}

.detail {
	display: grid;
	gap: 8px;
}

.detail p {
	margin: 0;
}

.grid {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
	gap: 10px;
}

.tile {
	width: 100%;
	aspect-ratio: 1;
	display: grid;
	place-items: center;
	align-content: center;
	gap: 4px;
	padding: 6px;
	background: var(--input-bg);
	color: var(--text);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	text-align: center;
}

.tile:hover {
	border-color: var(--accent);
}

.icon {
	font-size: 2em;
}

.name {
	font-size: 0.85em;
}

.count {
	color: var(--muted);
}

.forms {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
	gap: 16px;
	align-items: start;
}
</style>
