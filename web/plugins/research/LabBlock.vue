<script setup lang="ts">
// On an institute's entry: what its settlement is researching, and starting research there
// (paid by that settlement, at its research speed).
import { computed } from 'vue';
import type { TechInfo } from '../../../src/shared/api';
import { formatNumber } from '../../core/format';
import type { Entry } from '../../core/game';
import { useGame } from '../../core/game';
import { techText } from './text';
import { duration } from './time';

const props = defineProps<{ entry: Entry }>();
const game = useGame();
const resources = game.use('resources');
const settlement = game.use('settlement');
// The view is for the selected settlement; the entry is always one of its buildings.
const tree = computed(() => (settlement.current.value?.id === props.entry.data?.settlement ? game.view('research.tree') : undefined));
const icons = new Map((game.meta.resources ?? []).map((r) => [r.id, r.icon ?? r.id]));
const names = computed(() => new Map((tree.value?.techs ?? []).map((t) => [t.id, game.t(t.name)])));
const text = techText(game);
// Techs with a next level, in tree order: branch by branch, tier by tier.
const branchOrder = computed(() => [...new Set((tree.value?.techs ?? []).map((t) => t.branch ?? ''))]);
const open = computed(() =>
	(tree.value?.techs ?? [])
		.filter((t) => t.next)
		.sort(
			(a, b) =>
				branchOrder.value.indexOf(a.branch ?? '') - branchOrder.value.indexOf(b.branch ?? '') ||
				(a.tier ?? 0) - (b.tier ?? 0) ||
				(a.order ?? 0) - (b.order ?? 0),
		),
);
const remaining = computed(() =>
	tree.value?.current ? Math.max(0, Math.ceil((tree.value.current.finishesAt - game.serverNow()) / 1000)) : 0,
);
const progress = computed(() => {
	const c = tree.value?.current;
	return c ? Math.min(100, ((game.serverNow() - c.startedAt) / (c.finishesAt - c.startedAt)) * 100) : 0;
});
const canStart = (t: TechInfo) => !!t.next && !t.next.blocked && !tree.value?.current && resources.canAfford(t.next.cost);
const short = (r: string | number, n: number) => resources.current(String(r)) < n;
const start = (t: TechInfo) => game.command('research.start', { tech: t.id, settlement: props.entry.data!.settlement });
</script>

<template>
	<section v-if="tree" class="card lab">
		<h2>{{ game.t('Research') }}</h2>
		<small class="muted">
			{{
				game.t('Researching in {name} (speed ×{speed}); costs are paid by it.', {
					name: game.t(settlement.current.value?.name ?? ''),
					speed: formatNumber(tree.speed, { decimals: 2 }),
				})
			}}
		</small>
		<div v-if="tree.current" class="current">
			<strong>{{ names.get(tree.current.tech) }} {{ tree.current.targetLevel }}</strong>
			<small> · {{ remaining > 0 ? duration(remaining) : game.t('finishing…') }}</small>
			<div class="bar"><div :style="{ width: `${progress}%` }"></div></div>
		</div>
		<ul class="techs">
			<li v-for="t in open" :key="t.id">
				<div class="head">
					<strong>{{ game.t(t.name) }}</strong>
					<small>{{ game.t('Lv') }} {{ t.level }}/{{ t.maxLevel }}</small>
					<small v-if="t.branch" class="muted">{{ game.t(t.branch) }} · {{ game.t(`research-tier:${t.tier ?? 1}`) }}</small>
				</div>
				<small v-for="u in t.unlocks" :key="u.building" class="muted">{{ text.unlock(t, u) }}</small>
				<small v-for="(e, k) in t.effects" :key="k" class="muted">{{ text.effect(e) }} {{ game.t('per level') }}</small>
				<small>
					<span v-for="(n, r) in t.next!.cost" :key="r" class="part" :class="{ short: short(r, n) }"
						>{{ icons.get(String(r)) }}{{ formatNumber(n) }}</span
					>
					· {{ duration(t.next!.seconds) }}
				</small>
				<small v-if="t.next!.blocked" class="blocked">{{ game.t(t.next!.blocked) }}</small>
				<button type="button" class="small" :disabled="!canStart(t)" @click="start(t)">
					{{ game.t('Research Lv {n}', { n: t.next!.level }) }}
				</button>
			</li>
		</ul>
	</section>
</template>

<style scoped>
.lab {
	display: grid;
	gap: 10px;
}

.current {
	display: grid;
	gap: 6px;
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

.techs {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
	gap: 10px;
}

.techs li {
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 10px;
	display: grid;
	gap: 6px;
	align-content: start;
}

.head {
	display: flex;
	gap: 6px;
	align-items: baseline;
}

.part + .part {
	margin-left: 6px;
}

.short,
.blocked {
	color: var(--danger);
}

button {
	justify-self: start;
}
</style>
