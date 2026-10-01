<script setup lang="ts">
// The wall's works and defences. Only shown for the selected settlement (the view is for it).
import { computed } from 'vue';
import type { Entry } from '../../core/game';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

const props = defineProps<{ entry: Entry }>();
const game = useGame();
const wall = computed(() => {
	const w = game.view('starter-siege.wall');
	return w && w.settlement === props.entry.data?.settlement ? w : null;
});
const icons = new Map((game.meta.resources ?? []).map((r) => [r.id, r.icon ?? r.id]));
const amounts = (c: Record<string, number>, decimals = 0) =>
	Object.entries(c)
		.filter(([, n]) => n > 0)
		.map(([r, n]) => `${icons.get(r) ?? r}${formatNumber(n, { decimals })}`)
		.join(' ');
const duration = (s: number) =>
	s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
const left = computed(() => (wall.value?.queue ? Math.max(0, Math.ceil((wall.value.queue.finishesAt - game.serverNow()) / 1000)) : 0));
const nameOf = (kind: string, id: string) =>
	game.t((kind === 'work' ? wall.value?.works : wall.value?.devices)?.find((x) => x.id === id)?.name ?? id);
const pct = (v: number) => `${v > 0 ? '+' : '−'}${Math.abs(v)}%`;
</script>

<template>
	<section v-if="wall" class="card siege">
		<p v-if="wall.queue" class="queue">
			{{
				game.t('Building: {item} ×{n} · {t}', {
					item: nameOf(wall.queue.kind, wall.queue.item),
					n: wall.queue.kind === 'work' ? 1 : wall.queue.amount,
					t: duration(left),
				})
			}}
		</p>
		<h3>{{ game.t('Wall works') }}</h3>
		<ul>
			<li v-for="w in wall.works" :key="w.id">
				<strong>{{ w.icon }} {{ game.t(w.name) }}</strong>
				<small
					>{{ game.t('Lv {n}/{max}', { n: w.level, max: w.maxLevel })
					}}<template v-if="w.level"> · {{ game.t(`stat:${w.effect}`) }} {{ pct(w.value) }}</template></small
				>
				<small v-if="w.next" class="muted">{{
					game.t('next: {effect} · {cost} · {t}', {
						effect: `${game.t(`stat:${w.effect}`)} ${pct(w.next.value)}`,
						cost: amounts(w.next.cost),
						t: duration(w.next.seconds),
					})
				}}</small>
			</li>
		</ul>
		<h3>{{ game.t('Siege defences') }}</h3>
		<ul>
			<li v-for="d in wall.devices" :key="d.id" :class="{ locked: d.wall > wall.wall }">
				<strong
					>{{ d.icon }} {{ game.t(d.name) }}<template v-if="d.count"> ×{{ d.count }}</template></strong
				>
				<small class="muted">{{
					game.t('each: {effect} · {cost} · {t} · keep {upkeep}/h', {
						effect: `${game.t(`stat:${d.stat}`)} +${d.value}`,
						cost: amounts(d.cost),
						t: duration(d.seconds),
						upkeep: amounts(d.upkeep, 2),
					})
				}}</small>
				<small v-if="d.wall > wall.wall" class="muted">{{ game.t('needs wall Lv {n}', { n: d.wall }) }}</small>
			</li>
		</ul>
		<small v-if="amounts(wall.upkeep)">{{ game.t('Upkeep: {upkeep}/h', { upkeep: amounts(wall.upkeep, 1) }) }}</small>
	</section>
</template>

<style scoped>
.siege ul {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 6px;
}

.siege li {
	display: grid;
	gap: 1px;
}

.siege li.locked {
	opacity: 0.6;
}

h3 {
	margin: 8px 0 4px;
}

.queue {
	margin: 0;
	color: var(--accent);
}
</style>
