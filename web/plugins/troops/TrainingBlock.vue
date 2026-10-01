<script setup lang="ts">
// On a barracks entry: the settlement's training in progress, or why its units cannot be
// trained now (then there is no form). The training form itself is a server form placed on
// the building entry.
import { computed } from 'vue';
import type { Entry } from '../../core/game';
import { useGame } from '../../core/game';

const props = defineProps<{ entry: Entry }>();
const game = useGame();
const units = new Map((game.meta.units ?? []).map((u) => [u.id, u]));
const g = computed(() => {
	const v = game.view('troops.garrison');
	return v && v.settlement === props.entry.data?.settlement ? v : null;
});
// Units trained in this kind of building, and the first reason none of them can be.
const here = computed(() => (g.value?.trainable ?? []).filter((t) => units.get(t.unit)?.trainedAt === props.entry.type));
const blocked = computed(() => (here.value.length && here.value.every((t) => t.blocked) ? here.value[0].blocked : null));
const remaining = computed(() => {
	const t = g.value?.training;
	if (!t) return '';
	const s = Math.max(0, Math.ceil((t.finishesAt - game.serverNow()) / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
});
const progress = computed(() => {
	const t = g.value?.training;
	return t ? Math.min(100, ((game.serverNow() - t.startedAt) / (t.finishesAt - t.startedAt)) * 100) : 0;
});
</script>

<template>
	<section v-if="g && (g.training || blocked)" class="card training">
		<h2>{{ game.t(g.training ? 'Training' : 'Troop training') }}</h2>
		<div v-if="g.training">
			<small> {{ game.t(units.get(g.training.unit)?.name ?? g.training.unit) }} ×{{ g.training.count }} · {{ remaining }} </small>
			<div class="bar"><div :style="{ width: `${progress}%` }"></div></div>
			<small class="muted">{{ game.t('One batch at a time per settlement, in all its barracks.') }}</small>
		</div>
		<small v-else class="muted">{{ game.t(blocked!) }}</small>
	</section>
</template>

<style scoped>
.training {
	display: grid;
	gap: 6px;
}

.bar {
	height: 6px;
	margin: 4px 0;
	border-radius: 3px;
	background: var(--border);
	overflow: hidden;
}

.bar div {
	height: 100%;
	background: var(--accent);
}
</style>
