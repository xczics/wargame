<script setup lang="ts">
// Heroes serving the selected settlement and what they give it. On a building entry: only the
// posts at that building (e.g. the institute's scholars); on the city page: the others.
import { computed } from 'vue';
import { formatNumber } from '../../core/format';
import type { Entry } from '../../core/game';
import { useGame } from '../../core/game';

const props = defineProps<{ entry?: Entry }>();
const game = useGame();
const heroes = game.use('heroes');
const byId = computed(() => new Map((game.view('heroes.list') ?? []).map((h) => [h.id, h])));
const posts = computed(() =>
	(game.view('starter-heroes.posts') ?? []).filter((p) => (props.entry ? p.building === props.entry.type : !p.building)),
);
// Effects that shorten or lessen something read as a reduction.
const REDUCTIONS = new Set(['construction', 'training', 'upkeep', 'research', 'casualty']);
const effect = (e: { effect: string; percent: number }) =>
	`${game.t(`effect:${e.effect}`)} ${REDUCTIONS.has(e.effect) ? '−' : '+'}${formatNumber(e.percent, { decimals: 1 })}%`;
</script>

<template>
	<section v-if="posts.length" class="card posts">
		<h2>{{ game.t(entry ? 'Heroes here' : 'Heroes of this settlement') }}</h2>
		<div v-for="p in posts" :key="p.post" class="post">
			<div class="head">
				<strong>{{ game.t(p.name) }}</strong>
				<small v-if="p.limit" class="muted">{{ p.heroes.length }} / {{ p.limit }}</small>
			</div>
			<p v-if="!p.heroes.length" class="muted">
				<small>{{ game.t('Nobody.') }}</small>
				<button type="button" class="link" @click="game.showPage('heroes')">{{ game.t('Assign heroes') }}</button>
			</p>
			<template v-else>
				<small>{{ p.heroes.map((id) => (byId.get(id) ? heroes.name(byId.get(id)!) : '?')).join('、') }}</small>
				<small class="effects">{{ p.effects.map(effect).join(' · ') }}</small>
			</template>
		</div>
	</section>
</template>

<style scoped>
.posts {
	display: grid;
	gap: 8px;
}

.post {
	display: grid;
	gap: 2px;
	padding-top: 6px;
	border-top: 1px solid var(--border);
}

.head {
	display: flex;
	gap: 8px;
	align-items: baseline;
}

.effects {
	color: var(--info);
}
</style>
