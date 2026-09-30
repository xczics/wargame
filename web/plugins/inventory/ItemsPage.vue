<script setup lang="ts">
import { computed } from 'vue';
import { useGame } from '../../core/game';

const game = useGame();
const { Outlet } = game.use('forms');
const settlement = game.use('settlement');
const items = computed(() => game.view('items.inventory') ?? []);
</script>

<template>
	<section class="card">
		<h2>{{ game.t('Items') }}</h2>
		<p v-if="!items.length" class="muted">{{ game.t('Your inventory is empty.') }}</p>
		<ul v-else class="items">
			<li v-for="i in items" :key="i.id">
				<span class="icon">{{ i.icon }}</span>
				<span class="info">
					<strong
						>{{ game.t(i.name) }} <small>×{{ i.count }}</small></strong
					>
					<small class="muted">{{ game.t(i.description ?? '') }}</small>
				</span>
			</li>
		</ul>
		<small v-if="items.some((i) => i.usable)" class="muted">{{
			game.t('Usable items apply to the selected settlement: {name}.', { name: game.t(settlement.current.value?.name ?? '') })
		}}</small>
	</section>
	<div class="forms">
		<component :is="Outlet" placement="items" />
	</div>
</template>

<style scoped>
.items {
	list-style: none;
	margin: 0 0 8px;
	padding: 0;
	display: grid;
	gap: 8px;
}

.items li {
	display: flex;
	gap: 10px;
	align-items: center;
}

.icon {
	font-size: 1.5em;
}

.info {
	display: grid;
}

.forms {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
	gap: 16px;
	align-items: start;
}
</style>
