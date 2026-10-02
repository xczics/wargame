<script setup lang="ts">
// Candidates on offer in the selected settlement (on a building entry: only that building's venue).
import { computed } from 'vue';
import { formatNumber } from '../../core/format';
import type { Entry } from '../../core/game';
import { useGame } from '../../core/game';

const props = defineProps<{ entry?: Entry }>();
const game = useGame();
const heroes = game.use('heroes');
const resources = game.use('resources');
const icons = new Map((game.meta.resources ?? []).map((r) => [r.id, r.icon ?? r.id]));
const venueOf = new Map((game.meta.heroes?.venues ?? []).map((v) => [v.id, v.building]));
const offers = computed(() =>
	(game.view('heroes.candidates') ?? []).filter((o) => !props.entry || venueOf.get(o.venue) === props.entry.type),
);
const attrs = game.meta.heroes?.attributes ?? [];
const left = (t: number) => {
	const s = Math.max(0, Math.ceil((t - game.serverNow()) / 1000));
	return s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const recruit = (settlement: string, venue: string, slot: number, gift?: string) =>
	game.command('heroes.recruit', gift ? { settlement, venue, gift } : { settlement, venue, slot });
</script>

<template>
	<section class="card">
		<h2>{{ game.t('Candidates') }}</h2>
		<p v-if="!offers.length" class="muted">{{ game.t('No recruiting buildings here.') }}</p>
		<div v-for="o in offers" :key="o.venue" class="venue">
			<div class="head">
				<strong>{{ game.t(o.name) }}</strong>
				<small class="muted">{{ game.t('New candidates in {t}', { t: left(o.refreshesAt) }) }}</small>
			</div>
			<div class="list">
				<div v-for="(c, i) in o.candidates" :key="i" class="candidate">
					<template v-if="c">
						<strong>{{ c.gender === 'f' ? '👸' : '🧔' }} {{ heroes.name(c) }}</strong>
						<ul class="attrs">
							<li v-for="a in attrs" :key="a.id">
								<small>{{ game.t(a.name) }}</small> <strong :class="{ high: (c.attrs[a.id] ?? 0) > 100 }">{{ c.attrs[a.id] ?? 0 }}</strong>
								<small v-if="c.talents?.[a.id]" class="talent" :title="game.t('Talent: gained every level')">▲{{ c.talents[a.id] }}</small>
							</li>
						</ul>
						<button
							type="button"
							class="small"
							:disabled="!c.gift && !resources.canAfford(o.cost)"
							@click="recruit(o.settlement, o.venue, c.slot, c.gift)"
						>
							{{ game.t('Recruit') }} ·
							<template v-if="c.gift">{{ game.t('free') }}</template>
							<span v-for="(n, r) in o.cost" v-else :key="r">{{ icons.get(String(r)) }}{{ formatNumber(n) }}</span>
						</button>
					</template>
					<small v-else class="muted">{{ game.t(o.taken.includes(i) ? 'Recruited' : 'Nobody this time') }}</small>
				</div>
			</div>
		</div>
	</section>
</template>

<style scoped>
.venue {
	display: grid;
	gap: 8px;
	margin-bottom: 12px;
}

.head {
	display: flex;
	gap: 8px;
	align-items: baseline;
	flex-wrap: wrap;
}

.list {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
	gap: 8px;
}

.candidate {
	display: grid;
	gap: 6px;
	padding: 10px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
	align-content: start;
}

.talent {
	color: var(--info);
}

.attrs {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: 2px 8px;
	font-variant-numeric: tabular-nums;
}

.high {
	color: var(--accent);
}

button {
	justify-self: start;
}
</style>
