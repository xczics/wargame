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
// What the player has, each bonus once (wherever the GM put it, in however many groups: user 2026-10-19, "只显示总效果，
// 不显示分组（和GM的设置解偶）。只显示已获得的效果"). Decreases are factors 1 / (1 + total): shown as what they take off.
const rows = computed(() => {
	const total = new Map<string, number>();
	(texts.value?.groups ?? []).forEach((parts, i) => {
		const steps = status.value?.steps[i] ?? 0;
		if (steps) for (const p of parts) total.set(p.bonus, (total.get(p.bonus) ?? 0) + steps * p.step);
	});
	return [...total].flatMap(([bonus, percent]) => {
		const def = texts.value?.bonuses[bonus];
		if (!def || percent <= 0) return [];
		const shown = def.direction === 'decrease' ? -(1 - 1 / (1 + percent / 100)) * 100 : percent;
		return [{ bonus, name: game.t(def.name), value: signed(shown, true, 1) }];
	});
});
</script>

<template>
	<section class="card">
		<h3>☯️ {{ game.t('Opaque research') }}</h3>
		<p v-if="!rows.length" class="muted">
			{{
				status?.unlocked
					? game.t('No breakthroughs yet: projects approved at the Shuangqing Temple bring them.')
					: game.t('Research projects are approved at the Shuangqing Temple in your capital.')
			}}
		</p>
		<table v-else>
			<tbody>
				<tr v-for="r in rows" :key="r.bonus">
					<td>{{ r.name }}</td>
					<td class="num">{{ r.value }}</td>
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

.num {
	text-align: right;
}
</style>
