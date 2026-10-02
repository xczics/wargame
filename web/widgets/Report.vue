<script setup lang="ts">
// Generic widget "ui.report": a report (e.g. a mail, from its `report`, or a view): a badge and lines,
// label-value fields, a lane-by-lane account (open, can be folded), notes; its edge coloured good / bad.
import { computed } from 'vue';
import type { MailMessage } from '../../src/shared/api';
import type { ReportData } from '../../src/shared/ui';
import { useGame } from '../core/game';
import Lanes from './Lanes.vue';
import Line from './Line.vue';
import { uiText } from './text';

const props = defineProps<{ view?: string; message?: MailMessage }>();
const game = useGame('widgets');
const report = computed(
	() => props.message?.report ?? ((props.view ? game.state.value?.views[props.view] : null) as ReportData | null) ?? null,
);
</script>

<template>
	<div v-if="report" class="report" :class="report.tone">
		<p v-for="(l, i) in report.lines ?? []" :key="`l${i}`">
			<span v-if="i === 0 && report.badge" class="badge">{{ uiText(game, report.badge) }}</span>
			<Line :line="l" />
		</p>
		<dl v-if="report.fields?.length">
			<template v-for="(f, i) in report.fields" :key="i">
				<dt>{{ uiText(game, f.label) }}</dt>
				<dd>
					<template v-for="(v, k) in f.value" :key="k"
						>{{ k ? game.t(', ') : ''
						}}<span :class="[v.tone, v.rarity ? `rarity rarity-${v.rarity}` : '']">{{ uiText(game, v.text) }}</span></template
					>
				</dd>
			</template>
		</dl>
		<details v-if="report.lanes?.title" open>
			<summary>
				<small>{{ uiText(game, report.lanes.title) }}</small>
			</summary>
			<Lanes :data="report.lanes" />
		</details>
		<Lanes v-else-if="report.lanes" :data="report.lanes" />
		<Line v-for="(l, i) in report.notes ?? []" :key="`n${i}`" :line="l" />
	</div>
</template>

<style scoped>
.report {
	border-left: 3px solid var(--border);
	padding-left: 10px;
	margin-top: 8px;
	display: grid;
	gap: 6px;
}

.report.good {
	border-color: var(--info);
}

.report.bad {
	border-color: var(--danger);
}

.report p {
	margin: 0;
}

.report p :deep(small) {
	font-size: inherit;
}

dl {
	display: grid;
	grid-template-columns: max-content 1fr;
	gap: 2px 12px;
	margin: 0;
}

dt {
	color: var(--muted);
}

dd {
	margin: 0;
}

.info {
	color: var(--info);
}

.warn {
	color: var(--danger);
}

.muted {
	color: var(--muted);
}
</style>
