<script setup lang="ts">
// An adventure report: each group fought, the hero's hp, what dropped, the outcome.
import { computed } from 'vue';
import type { MailMessage, RealmMail, RewardLine } from '../../../src/shared/api';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

const props = defineProps<{ message: MailMessage }>();
const game = useGame();
const heroes = game.use('heroes');
const r = computed(() => props.message.data as RealmMail);
const n = (x: number) => formatNumber(x);
/** After the name: how many, and whether it was lost. */
const suffix = (l: RewardLine) => `${l.count && l.count > 1 ? ` ×${l.count}` : ''}${l.lost ? ` ${game.t('(lost: bag full)')}` : ''}`;
</script>

<template>
	<div class="report" :class="r.injured ? 'defeat' : 'victory'">
		<p>
			<strong>{{ heroes.name(r.hero) }}</strong> · {{ game.t(r.realmName) }} · {{ game.t(r.taskName) }}
		</p>
		<small class="muted">{{
			game.t('Attack {a} · Defence {d} · HP {h} · Recovery {r}%', {
				a: n(r.stats.attack),
				d: n(r.stats.defense),
				h: n(r.stats.hp),
				r: formatNumber(r.stats.recovery, { decimals: 1 }),
			})
		}}</small>
		<table>
			<thead>
				<tr>
					<th>{{ game.t('Group') }}</th>
					<th>{{ game.t('Attack / defence / HP') }}</th>
					<th>{{ game.t('Hero HP') }}</th>
					<th></th>
					<th>{{ game.t('Rewards') }}</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="(g, i) in r.groups" :key="i">
					<td>{{ g.boss ? '👑 ' : '' }}{{ game.t(g.name) }}</td>
					<td>{{ n(g.attack) }} / {{ n(g.defense) }} / {{ n(g.hp) }}</td>
					<td>{{ n(g.hpBefore) }} → {{ n(g.hpAfter) }}</td>
					<td>{{ g.won ? '✔' : '✘' }}</td>
					<td>
						<template v-for="(l, k) in g.rewards" :key="k"
							>{{ k ? '、' : '' }}{{ l.icon ?? '' }}<span :class="l.rarity ? `rarity rarity-${l.rarity}` : ''">{{ game.t(l.name) }}</span
							>{{ suffix(l) }}</template
						>
					</td>
				</tr>
			</tbody>
		</table>
		<p>
			{{ game.t('Experience +{n}', { n: n(r.exp) }) }}<template v-if="r.levels"> · {{ game.t('up {n} levels', { n: r.levels }) }}</template>
		</p>
		<p v-if="r.clearRewards.length">
			{{ game.t('Cleared:') }}
			<template v-for="(l, k) in r.clearRewards" :key="k"
				>{{ k ? '、' : '' }}{{ l.icon ?? '' }}<span :class="l.rarity ? `rarity rarity-${l.rarity}` : ''">{{ game.t(l.name) }}</span
				>{{ suffix(l) }}</template
			>
		</p>
		<p v-if="r.injured" class="danger">{{ game.t('The hero fell and is injured: treat it at its settlement.') }}</p>
	</div>
</template>

<style scoped>
.report {
	display: grid;
	gap: 8px;
}

.report p {
	margin: 0;
}

table {
	border-collapse: collapse;
	font-variant-numeric: tabular-nums;
}

th,
td {
	text-align: left;
	padding: 2px 8px 2px 0;
	border-bottom: 1px solid var(--border);
	font-size: 0.9em;
}

.danger {
	color: var(--danger);
}
</style>
