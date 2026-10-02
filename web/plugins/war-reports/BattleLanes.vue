<script setup lang="ts">
// Lane-by-lane account of a battle, seen from one side ("us" = `side`).
import type { BattleDetail } from '../../../src/shared/api';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

const props = defineProps<{ detail: BattleDetail; side: 'attacker' | 'defender' }>();
const game = useGame();
const other = props.side === 'attacker' ? 'defender' : 'attacker';
const families = new Map((game.meta.battleFamilies ?? []).map((f) => [f.id, f]));
const unitNames = new Map((game.meta.units ?? []).map((u) => [u.id, u.name]));
const family = (id: string) => `${families.get(id)?.icon ?? ''} ${game.t(families.get(id)?.name ?? id)}`;
const heads = (u: Record<string, number>) => Object.values(u).reduce((a, b) => a + b, 0);
const lost = (u: Record<string, number>) =>
	Object.entries(u)
		.filter(([, n]) => n > 0)
		.map(([id, n]) => `${game.t(unitNames.get(id) ?? id)} ${formatNumber(n, { decimals: 1 })}`)
		.join('，');
const n = (v: number) => formatNumber(v);
// Sources may name heroes by their name-part keys ("s:Zhao m:Zilong", e.g. NPC defenders): spell them.
const names = game.meta.heroNames ?? {};
const spell = (key: string) => names[game.locale.value]?.[key] ?? names.en?.[key] ?? key.slice(2);
const source = (text: string) =>
	game.t(
		text.replace(/\b(s:[^\s,]+) ([mf]:[^\s,]+)/g, (_, sur: string, given: string) =>
			game.locale.value.startsWith('zh') ? `${spell(sur)}${spell(given)}` : `${spell(sur)} ${spell(given)}`,
		),
	);
// Bonuses are sums of per-point effects: show one decimal, never float noise like 11.200000000000001.
const pct = (v: number) => `${v > 0 ? '+' : ''}${formatNumber(v, { decimals: 1 })}%`;
</script>

<template>
	<div class="lanes">
		<small class="muted">
			{{ game.t('Result') }}：<strong>{{ game.t(`grade:${detail.grade[side]}`) }}</strong> （{{
				game.t('{a} lanes to {b}', { a: detail.wins[side], b: detail.wins[other] })
			}}，{{ game.t('losses ×{f}', { f: formatNumber(detail.casualtyFactor[side], { decimals: 2 }) }) }}）
		</small>
		<table>
			<thead>
				<tr>
					<th></th>
					<th>{{ game.t('Us') }}</th>
					<th>{{ game.t('Them') }}</th>
				</tr>
			</thead>
			<tbody>
				<tr v-for="(lane, i) in detail.lanes" :key="i" :class="lane.winner === side ? 'won' : 'lost'">
					<th>{{ game.t('Lane {0}', { 0: i + 1 }) }}</th>
					<td v-for="who in [side, other] as const" :key="who">
						<div>
							{{ family(lane[who].family) }} ×{{ n(heads(lane[who].units)) }}
							<span v-if="lane[who].counters" class="counter">{{ game.t('counters') }}</span>
						</div>
						<small class="muted">
							{{ game.t('atk') }} {{ n(lane[who].attack) }} · {{ game.t('def') }} {{ n(lane[who].defense) }} · {{ game.t('hp') }}
							{{ n(lane[who].hp) }}
						</small>
						<small v-if="lost(lane[who].lost)" class="loss">−{{ lost(lane[who].lost) }}</small>
					</td>
				</tr>
			</tbody>
		</table>
		<small class="muted">{{ game.t('Lane losses are before the casualty factor; the totals above are after it.') }}</small>
		<small v-for="who in [side, other] as const" :key="who" class="muted">
			<template v-if="detail.modifiers[who].length">
				{{ game.t(who === side ? 'Our bonuses' : 'Their bonuses') }}：
				<span v-for="m in detail.modifiers[who]" :key="m.source + m.stat" class="part"
					>{{ source(m.source) }} {{ game.t(m.stat) }}<template v-if="m.flat"> +{{ n(m.flat) }}</template
					><template v-if="m.percent"> {{ pct(m.percent) }}</template></span
				>
			</template>
		</small>
	</div>
</template>

<style scoped>
.lanes {
	display: grid;
	gap: 4px;
	margin: 4px 0;
}

table {
	border-collapse: collapse;
	width: 100%;
	font-size: 0.9em;
}

th,
td {
	text-align: left;
	padding: 4px 6px;
	border-bottom: 1px solid var(--border);
	vertical-align: top;
}

td small {
	display: block;
}

tr.won th {
	color: var(--info);
}

tr.lost th {
	color: var(--danger);
}

.counter {
	font-size: 0.8em;
	color: var(--accent);
	margin-left: 4px;
}

.loss {
	color: var(--danger);
}

.part + .part {
	margin-left: 8px;
}
</style>
