<script setup lang="ts">
// Heroes away on adventures, and injured ones (with their treatment).
import { computed } from 'vue';
import type { HeroInfo } from '../../../src/shared/api';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';
import { duration } from './time';

const game = useGame();
const heroes = game.use('heroes');
const o = computed(() => game.view('realms.overview'));
const byId = computed(() => new Map((game.view('heroes.list') ?? []).map((h) => [h.id, h])));
const realmName = (id: string) => game.t(o.value?.realms.find((r) => r.id === id)?.name ?? id);
const taskName = (realm: string, task: number) => game.t(o.value?.realms.find((r) => r.id === realm)?.tasks[task]?.name ?? '');
const name = (id: string) => {
	const h = byId.value.get(id);
	return h ? heroes.name(h as HeroInfo) : '';
};
const left = (t: number) => Math.max(0, Math.ceil((t - game.serverNow()) / 1000));
const icons = new Map((game.meta.resources ?? []).map((r) => [r.id, r.icon ?? r.id]));
const cost = (c: Record<string, number>) =>
	Object.entries(c)
		.map(([r, n]) => `${icons.get(r) ?? r}${formatNumber(n)}`)
		.join(' ');
</script>

<template>
	<section v-if="o" class="card">
		<h2>{{ game.t('On adventures') }}</h2>
		<p v-if="!o.adventures.length" class="muted">{{ game.t('Nobody is away.') }}</p>
		<ul class="list">
			<li v-for="a in o.adventures" :key="a.id">
				<strong>{{ name(a.hero) }}</strong>
				<small>{{ realmName(a.realm) }} · {{ taskName(a.realm, a.task) }}</small>
				<small class="muted">{{
					left(a.finishesAt) ? game.t('Back in {t}', { t: duration(left(a.finishesAt)) }) : game.t('finishing…')
				}}</small>
			</li>
		</ul>
	</section>
	<section v-if="o?.injured.length" class="card">
		<h2>{{ game.t('Injured heroes') }}</h2>
		<ul class="list">
			<li v-for="i in o.injured" :key="i.hero">
				<strong>{{ name(i.hero) }}</strong>
				<small v-if="i.healingUntil" class="muted">{{ game.t('Healed in {t}', { t: duration(left(i.healingUntil)) }) }}</small>
				<button v-else type="button" class="small" @click="game.command('realms.heal', { hero: i.hero })">
					{{ game.t('Treat ({cost}, {t})', { cost: cost(i.cost), t: duration(i.seconds) }) }}
				</button>
			</li>
		</ul>
	</section>
</template>

<style scoped>
.list {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 8px;
}

.list li {
	display: grid;
	gap: 2px;
	justify-items: start;
}
</style>
