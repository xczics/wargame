<script setup lang="ts">
// Generic widget "ui.timers": things under way with a countdown (and a bar when the start is known),
// status lines and buttons. On an entry (a building) only the lines for that entry's type show; the
// client resyncs when the first one ends.
import { computed, watch } from 'vue';
import type { TimersData } from '../../src/shared/ui';
import type { Entry } from '../core/game';
import { useGame } from '../core/game';
import { runAction } from './actions';
import { uiText } from './text';

const props = defineProps<{ view: string; entry?: Entry }>();
const game = useGame();
const data = computed(() => (game.state.value?.views[props.view] ?? null) as TimersData | null);
const here = (where?: string) => !props.entry || where === props.entry.type;
const items = computed(() => (data.value?.items ?? []).filter((i) => here(i.where)));
const notes = computed(() => (data.value?.notes ?? []).filter((n) => here(n.where)));
const left = (endsAt: number) => {
	const s = Math.max(0, Math.ceil((endsAt - game.serverNow()) / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
const progress = (startedAt: number, endsAt: number) =>
	Math.min(100, Math.max(0, ((game.serverNow() - startedAt) / (endsAt - startedAt)) * 100));
watch(
	() => Math.min(...items.value.flatMap((i) => (i.endsAt ? [i.endsAt] : []))),
	(t) => Number.isFinite(t) && game.refreshAt(t),
	{ immediate: true },
);
</script>

<template>
	<section v-if="data && (items.length || notes.length)" class="card timers">
		<h2 v-if="data.title">{{ uiText(game, data.title) }}</h2>
		<ul class="plain">
			<li v-for="i in items" :key="i.id">
				<div class="row">
					<small
						>{{ i.icon ?? '' }} {{ uiText(game, i.title) }}<template v-if="i.endsAt"> · {{ left(i.endsAt) }}</template></small
					>
					<button
						v-for="(a, k) in i.actions ?? []"
						:key="k"
						type="button"
						class="link"
						:disabled="!!a.blocked"
						:title="a.blocked ? uiText(game, a.blocked) : undefined"
						@click="runAction(game, a)"
					>
						{{ uiText(game, a.label) }}
					</button>
				</div>
				<div v-if="i.startedAt && i.endsAt" class="bar">
					<div :style="{ width: `${progress(i.startedAt, i.endsAt)}%` }"></div>
				</div>
				<small v-for="(l, k) in i.lines ?? []" :key="`l${k}`" :class="l.tone === 'warn' ? 'warn' : 'muted'">{{
					uiText(game, l.text)
				}}</small>
			</li>
		</ul>
		<small v-for="(n, k) in notes" :key="`n${k}`" :class="n.tone === 'warn' ? 'warn' : 'muted'">{{ uiText(game, n.text) }}</small>
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
</style>
