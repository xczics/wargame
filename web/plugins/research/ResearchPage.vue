<script setup lang="ts">
import { computed } from 'vue';
import type { TechInfo } from '../../../src/shared/api';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

const game = useGame();
const resources = game.use('resources');
const settlement = game.use('settlement');
const tree = computed(() => game.view('research.tree'));
const icons = new Map((game.meta.resources ?? []).map((r) => [r.id, r.icon ?? r.id]));
const names = computed(() => new Map((tree.value?.techs ?? []).map((t) => [t.id, game.t(t.name)])));
const settlementName = (id: string) => game.t(settlement.list.value.find((s) => s.id === id)?.name ?? id);
const elsewhere = computed(() => (tree.value?.all ?? []).filter((j) => j.settlement !== tree.value?.current?.settlement));

const duration = (s: number) =>
	s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
const remaining = computed(() =>
	tree.value?.current ? Math.max(0, Math.ceil((tree.value.current.finishesAt - game.serverNow()) / 1000)) : 0,
);
const progress = computed(() => {
	const c = tree.value?.current;
	return c ? Math.min(100, ((game.serverNow() - c.startedAt) / (c.finishesAt - c.startedAt)) * 100) : 0;
});
const canStart = (t: TechInfo) => !!t.next && !t.next.blocked && resources.canAfford(t.next.cost);
const short = (r: string | number, n: number) => resources.current(String(r)) < n;

function start(t: TechInfo) {
	const s = settlement.current.value;
	if (s) game.command('research.start', { tech: t.id, settlement: s.id });
}
</script>

<template>
	<section v-if="tree" class="card research">
		<h2>{{ game.t('Research') }}</h2>
		<div v-if="tree.current" class="current">
			<strong>{{ names.get(tree.current.tech) }} {{ tree.current.targetLevel }}</strong>
			<small> · {{ remaining > 0 ? duration(remaining) : game.t('finishing…') }}</small>
			<div class="bar"><div :style="{ width: `${progress}%` }"></div></div>
		</div>
		<p v-if="!tree.speed" class="muted">
			{{
				game.t('{name} has no institute. Build one in its inner city to research here — each settlement has its own research queue.', {
					name: game.t(settlement.current.value?.name ?? ''),
				})
			}}
		</p>
		<small v-else class="muted">
			{{
				game.t('Researching in {name} (speed ×{speed}); costs are paid by it.', {
					name: game.t(settlement.current.value?.name ?? ''),
					speed: formatNumber(tree.speed, { decimals: 2 }),
				})
			}}
		</small>
		<ul v-if="elsewhere.length" class="elsewhere">
			<li v-for="j in elsewhere" :key="j.settlement">
				<small
					>{{ settlementName(j.settlement) }}: {{ names.get(j.tech) }} {{ j.targetLevel }} ·
					{{ duration(Math.max(0, Math.ceil((j.finishesAt - game.serverNow()) / 1000))) }}</small
				>
			</li>
		</ul>
		<ul class="techs">
			<li v-for="t in tree.techs" :key="t.id">
				<div class="head">
					<strong>{{ game.t(t.name) }}</strong>
					<small>{{ game.t('Lv') }} {{ t.level }}/{{ t.maxLevel }}</small>
				</div>
				<small v-if="t.description" class="muted">{{ game.t(t.description) }}</small>
				<template v-if="t.next">
					<small>
						<span v-for="(n, r) in t.next.cost" :key="r" class="part" :class="{ short: short(r, n) }"
							>{{ icons.get(String(r)) }}{{ formatNumber(n) }}</span
						>
						· {{ duration(t.next.seconds) }}
					</small>
					<small v-if="t.next.blocked" class="blocked">{{ game.t(t.next.blocked) }}</small>
					<button type="button" class="small" :disabled="!canStart(t)" @click="start(t)">
						{{ game.t('Research Lv {n}', { n: t.next.level }) }}
					</button>
				</template>
				<small v-else class="muted">{{ game.t('Fully researched') }}</small>
			</li>
		</ul>
	</section>
</template>

<style scoped>
.research {
	display: grid;
	gap: 12px;
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

.elsewhere {
	list-style: none;
	margin: 0;
	padding: 0;
}

.techs {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
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
