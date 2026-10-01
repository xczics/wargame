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
// Only what can be researched now (prerequisites met, not maxed), grouped by branch, then tier.
// The whole tree, locked and finished techs included, is on the Research page.
const groups = computed(() => {
	const out: { branch: string; tiers: { tier: number; techs: TechInfo[] }[] }[] = [];
	for (const t of tree.value?.techs ?? []) {
		if (!t.next || t.next.locked) continue;
		const branch = t.branch ?? 'Other';
		let b = out.find((x) => x.branch === branch);
		if (!b) out.push((b = { branch, tiers: [] }));
		const tier = t.tier ?? 1;
		let g = b.tiers.find((x) => x.tier === tier);
		if (!g) b.tiers.push((g = { tier, techs: [] }));
		g.techs.push(t);
	}
	for (const b of out) {
		b.tiers.sort((x, y) => x.tier - y.tier);
		for (const g of b.tiers) g.techs.sort((x, y) => (x.order ?? 0) - (y.order ?? 0));
	}
	return out;
});
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
		<p v-if="!groups.length" class="muted">{{ game.t('Nothing can be researched right now. See the tech tree on the Research page.') }}</p>
		<div v-for="b in groups" :key="b.branch" class="group">
			<h3>{{ game.t(b.branch) }}</h3>
			<template v-for="g in b.tiers" :key="g.tier">
				<small class="tier-name">{{ game.t(`research-tier:${g.tier}`) }}</small>
				<ul class="techs">
					<li v-for="t in g.techs" :key="t.id">
						<div class="head">
							<strong>{{ game.t(t.name) }}</strong>
							<small>{{ game.t('Lv') }} {{ t.level }}/{{ t.maxLevel }}</small>
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
			</template>
		</div>
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

.group {
	display: grid;
	gap: 6px;
}

.group h3 {
	margin: 4px 0 0;
}

.tier-name {
	color: var(--muted);
	font-weight: 600;
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
