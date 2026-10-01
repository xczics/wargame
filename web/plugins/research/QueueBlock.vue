<script setup lang="ts">
// Research running in all the player's settlements (one queue per institute).
import { computed } from 'vue';
import { useGame } from '../../core/game';
import { duration } from './time';

const game = useGame();
const settlement = game.use('settlement');
const tree = computed(() => game.view('research.tree'));
const names = computed(() => new Map((tree.value?.techs ?? []).map((t) => [t.id, game.t(t.name)])));
const settlementName = (id: string) => game.t(settlement.list.value.find((s) => s.id === id)?.name ?? id);
const jobs = computed(() => [...(tree.value?.all ?? [])].sort((a, b) => a.finishesAt - b.finishesAt));
const left = (t: number) => Math.max(0, Math.ceil((t - game.serverNow()) / 1000));
const progress = (j: { startedAt: number; finishesAt: number }) =>
	Math.min(100, ((game.serverNow() - j.startedAt) / (j.finishesAt - j.startedAt)) * 100);
</script>

<template>
	<section v-if="tree" class="card queue">
		<h2>{{ game.t('Research queue') }}</h2>
		<p v-if="!jobs.length" class="muted">
			<small>{{ game.t('Nothing is being researched. Start research at an institute (open it on the Overview page).') }}</small>
		</p>
		<div v-for="j in jobs" :key="j.settlement" class="job">
			<small>
				<strong>{{ names.get(j.tech) }} {{ j.targetLevel }}</strong> · {{ settlementName(j.settlement) }} ·
				{{ left(j.finishesAt) > 0 ? duration(left(j.finishesAt)) : game.t('finishing…') }}
			</small>
			<div class="bar"><div :style="{ width: `${progress(j)}%` }"></div></div>
		</div>
	</section>
</template>

<style scoped>
.queue {
	display: grid;
	gap: 8px;
}

.job {
	display: grid;
	gap: 4px;
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
</style>
