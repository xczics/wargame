<script setup lang="ts">
// Generic widget "ui.timers": things under way with a countdown (and a bar when the start is known),
// status lines and buttons. On an entry (a building) only the lines for that entry's type show; the
// client resyncs when the first one ends.
import { computed, watch } from 'vue';
import type { TimersData } from '../../src/shared/ui';
import type { Entry } from '../core/game';
import { useGame } from '../core/game';
import ActionLabel from './ActionLabel.vue';
import { runAction, running } from './actions';
import Line from './Line.vue';
import { hintText, uiText } from './text';
import { left } from './time';

const props = defineProps<{ view: string; entry?: Entry }>();
const game = useGame('widgets');
const data = computed(() => (game.state.value?.views[props.view] ?? null) as TimersData | null);
// Lines without `where` belong everywhere; the others only on their entry.
const here = (where?: string) => !props.entry || where === undefined || where === props.entry.type;
const items = computed(() => (data.value?.items ?? []).filter((i) => here(i.where)));
const notes = computed(() => (data.value?.notes ?? []).filter((n) => here(n.where)));
const progress = (startedAt: number, endsAt: number) =>
	Math.min(100, Math.max(0, ((game.serverNow() - startedAt) / (endsAt - startedAt)) * 100));
watch(
	() => Math.min(...items.value.flatMap((i) => (i.endsAt ? [i.endsAt] : []))),
	(t) => Number.isFinite(t) && game.refreshAt(t),
	{ immediate: true },
);
</script>

<template>
	<section v-if="data && (items.length || notes.length)" class="card timers" :class="{ alert: data.tone === 'warn' }">
		<h2 v-if="data.title">{{ uiText(game, data.title) }}</h2>
		<ul class="plain">
			<li v-for="i in items" :key="i.id">
				<div class="row">
					<small
						>{{ i.icon ?? '' }} {{ uiText(game, i.title) }}<template v-if="i.endsAt"> · {{ left(game, i.endsAt) }}</template></small
					>
					<button
						v-for="(a, k) in i.actions ?? []"
						:key="k"
						type="button"
						class="link"
						:disabled="!!a.blocked || running(a)"
						:title="hintText(game, a)"
						@click="runAction(game, a)"
					>
						<ActionLabel :action="a" />
					</button>
				</div>
				<div v-if="i.startedAt && i.endsAt" class="bar">
					<div :style="{ width: `${progress(i.startedAt, i.endsAt)}%` }"></div>
				</div>
				<Line v-for="(l, k) in i.lines ?? []" :key="`l${k}`" :line="l" />
			</li>
		</ul>
		<Line v-for="(n, k) in notes" :key="`n${k}`" :line="n" />
	</section>
</template>

<style scoped>
.timers {
	display: grid;
	gap: 6px;
}

.timers li {
	display: grid;
	gap: 2px;
	margin-bottom: 6px;
}

.row {
	display: flex;
	justify-content: space-between;
	align-items: center;
	gap: 8px;
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

.warn {
	color: var(--danger);
}

.alert {
	border-color: var(--danger);
}
</style>
