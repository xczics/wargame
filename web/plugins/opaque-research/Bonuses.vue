<script setup lang="ts">
// Opaque research on the research page: what each group gives now (its bonuses, each its percent a step x the
// thresholds the group has passed); the hidden values stay hidden. The layout comes from the static texts (the GM's
// rule), the thresholds passed from the player's view.
import { computed } from 'vue';
import type { OpaqueStatus, OpaqueTexts } from '../../../src/shared/api';
import { signed } from '../../../src/shared/format';
import { useGame } from '../../core/game';

const props = defineProps<{ view?: string; texts?: string }>();
const game = useGame('opaque-research');
const status = computed(() => game.view('opaque-research.status') as OpaqueStatus | null);
const texts = computed(() => game.static<OpaqueTexts>(props.texts ?? 'opaque-research.texts'));
// Decreases are factors 1 / (1 + total): shown as what they take off.
const shown = (percent: number, decrease: boolean) => signed(decrease ? -(1 - 1 / (1 + percent / 100)) * 100 : percent, true, 1);
const rows = computed(() =>
	(texts.value?.groups ?? []).map((parts, i) => {
		const steps = status.value?.steps[i] ?? 0;
		return {
			group: i + 1,
			parts: parts.flatMap((p) => {
				const def = texts.value?.bonuses[p.bonus];
				return def ? [{ name: game.t(def.name), value: steps ? shown(steps * p.step, def.direction === 'decrease') : '—' }] : [];
			}),
		};
	}),
);
</script>

<template>
	<section class="card">
		<h3>☯️ {{ game.t('Opaque research') }}</h3>
		<p v-if="!status?.unlocked && !status?.steps.some(Boolean)" class="muted">
			{{ game.t('Research projects are approved at the Shuangqing Temple in your capital.') }}
		</p>
		<table>
			<tbody>
				<tr v-for="r in rows" :key="r.group">
					<td class="muted">{{ game.t('Group {n}', { n: r.group }) }}</td>
					<td>
						<div v-for="(p, i) in r.parts" :key="i" class="part">
							<span>{{ p.name }}</span>
							<span class="num">{{ p.value }}</span>
						</div>
						<span v-if="!r.parts.length" class="muted">—</span>
					</td>
				</tr>
			</tbody>
		</table>
	</section>
</template>

<style scoped>
table {
	width: 100%;
	border-collapse: collapse;
}

td {
	padding: 2px 4px;
	vertical-align: top;
}

.part {
	display: flex;
	justify-content: space-between;
	gap: 8px;
}

.num {
	text-align: right;
}
</style>
