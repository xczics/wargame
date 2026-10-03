<script setup lang="ts">
// Generic widget "ui.rows": lists in sections — each row an icon, a title with a badge (e.g. its
// level), status lines and buttons; rows not available yet are faded. A section may end with a row of
// small cells (e.g. accessory slots); a picker above sets a client parameter the view follows.
import { computed, ref } from 'vue';
import type { RowsData } from '../../src/shared/ui';
import type { Entry } from '../core/game';
import { useGame } from '../core/game';
import ActionLabel from './ActionLabel.vue';
import { runAction } from './actions';
import Cell from './Cell.vue';
import Line from './Line.vue';
import { chosen } from './state';
import { hintText, uiText } from './text';

const props = defineProps<{ view: string; entry?: Entry; filter?: string }>();
const game = useGame('widgets');
const data = computed(() => (game.state.value?.views[props.view] ?? null) as RowsData | null);
const local = ref<string | null>(null);
// The chosen group (shared through `filter`), if this data has it; otherwise its default.
const tab = computed(() => {
	const pick = props.filter ? chosen[props.filter] : local.value;
	return pick && (data.value?.sections ?? []).some((s) => s.group === pick) ? pick : (data.value?.defaultTab ?? null);
});
// On an entry: sections without `where`, or for this entry's type. Grouped ones only for the chosen group.
const sections = computed(() =>
	(data.value?.sections ?? []).filter(
		(s) => (!props.entry || s.where === undefined || s.where === props.entry.type) && (!s.group || s.group === tab.value),
	),
);
function choose(id: string) {
	if (props.filter) chosen[props.filter] = id;
	else local.value = id;
}
</script>

<template>
	<section v-if="data && sections.length" class="card rows">
		<h2 v-if="data.title">{{ uiText(game, data.title) }}</h2>
		<div v-if="data.tabs?.length" class="tabs">
			<button v-for="t in data.tabs" :key="t.id" type="button" class="small" :class="{ secondary: t.id !== tab }" @click="choose(t.id)">
				{{ uiText(game, t.label) }}
			</button>
		</div>
		<select
			v-if="data.picker?.options.length"
			class="picker"
			:value="data.picker.selected"
			@change="game.setParam(data.picker.param, ($event.target as HTMLSelectElement).value)"
		>
			<option v-for="o in data.picker.options" :key="o.value" :value="o.value">{{ uiText(game, o.label) }}</option>
		</select>
		<template v-for="(sec, k) in sections" :key="k">
			<h3 v-if="sec.title" :class="{ current: sec.current }">
				<button v-if="sec.actions?.length" type="button" class="link" @click="runAction(game, sec.actions[0])">
					{{ uiText(game, sec.title) }}
				</button>
				<template v-else>{{ uiText(game, sec.title) }}</template>
			</h3>
			<div v-if="sec.intro?.length" class="lines intro">
				<Line v-for="(l, i) in sec.intro" :key="i" :line="l" />
			</div>
			<ul>
				<li v-for="r in sec.rows" :key="r.id" :class="{ locked: r.locked }">
					<div class="head">
						<strong :class="r.rarity ? `rarity rarity-${r.rarity}` : ''">{{ r.icon ?? '' }} {{ uiText(game, r.title) }}</strong>
						<small v-if="r.badge">{{ uiText(game, r.badge) }}</small>
					</div>
					<Line v-for="(l, i) in r.lines ?? []" :key="i" :line="l" />
					<div v-if="r.actions?.length" class="actions">
						<button
							v-for="(a, i) in r.actions"
							:key="i"
							type="button"
							class="small"
							:disabled="!!a.blocked"
							:title="hintText(game, a)"
							@click="runAction(game, a)"
						>
							<ActionLabel :action="a" />
						</button>
					</div>
				</li>
			</ul>
			<div v-if="sec.cells?.length" class="cells" :style="{ gridTemplateColumns: `repeat(${sec.cells.length}, minmax(0, 1fr))` }">
				<Cell v-for="c in sec.cells" :key="c.id" :cell="c" />
			</div>
			<div v-if="sec.lines?.length" class="lines">
				<Line v-for="(l, i) in sec.lines" :key="i" :line="l" />
			</div>
		</template>
		<div v-if="data.notes?.length" class="lines notes">
			<Line v-for="(n, i) in data.notes" :key="i" :line="n" />
		</div>
	</section>
</template>

<style scoped>
.intro {
	margin-bottom: 8px;
}

.tabs {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin-bottom: 8px;
}

.picker {
	width: auto;
	margin-bottom: 8px;
}

.cells {
	display: grid;
	gap: 4px;
	max-width: 480px;
}

.rows ul {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 8px;
}

.rows li {
	display: grid;
	gap: 2px;
}

/* Rows with buttons are separate blocks (e.g. a realm's tasks). */
.rows li:has(.actions) + li {
	border-top: 1px solid var(--border);
	padding-top: 8px;
}

.rows li.locked {
	opacity: 0.6;
}

.head {
	display: flex;
	gap: 8px;
	align-items: baseline;
}

.actions {
	display: flex;
	gap: 6px;
}

h3 {
	margin: 8px 0 4px;
}

.lines {
	display: grid;
	gap: 2px;
	margin-top: 4px;
}

.notes {
	margin-top: 10px;
}

.current button,
h3.current {
	color: var(--accent);
}
</style>
