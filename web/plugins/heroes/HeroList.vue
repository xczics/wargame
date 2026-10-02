<script setup lang="ts">
// The heroes attached to the selected settlement (switch settlements to see the others).
import { computed } from 'vue';
import { useGame } from '../../core/game';
import HeroCard from './HeroCard.vue';

const game = useGame();
const settlement = game.use('settlement');
const all = computed(() => game.view('heroes.list') ?? []);
const here = computed(() => settlement.current.value);
const list = computed(() => all.value.filter((h) => h.home === here.value?.id));
</script>

<template>
	<section class="card">
		<h2>
			{{ game.t('Heroes of {name}', { name: game.t(here?.name ?? '') }) }}
			<small class="muted">({{ list.length }} / {{ all.length }})</small>
		</h2>
		<p v-if="!all.length" class="muted">{{ game.t('No heroes yet. Recruit them at a tavern, academy or music house.') }}</p>
		<p v-else-if="!list.length" class="muted">{{ game.t('No heroes are attached to this settlement.') }}</p>
		<HeroCard v-for="h in list" :key="`${h.id}-${h.duty}-${h.home}`" :hero="h" />
	</section>
</template>
