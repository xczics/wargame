<script setup lang="ts">
import { computed } from 'vue';
import { useGame } from '../../core/game';
import HeroCard from './HeroCard.vue';

const game = useGame();
const list = computed(() => game.view('heroes.list') ?? []);
</script>

<template>
	<section class="card">
		<h2>
			{{ game.t('My heroes') }} <small class="muted">({{ list.length }})</small>
		</h2>
		<p v-if="!list.length" class="muted">{{ game.t('No heroes yet. Recruit them at a tavern, academy or music house.') }}</p>
		<HeroCard v-for="h in list" :key="`${h.id}-${h.duty}-${h.home}`" :hero="h" />
	</section>
</template>
