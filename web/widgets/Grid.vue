<script setup lang="ts">
// Generic widget "ui.grid": a window of a grid map (src/shared/ui.ts GridData) from the server's view,
// fetched again for each centre (x, y, r). Moving, home and go-to; each cell's fill, icon and border;
// the legend; the selected cell's info and buttons, and the server forms of the data's `placement`
// (given x and y). Beside it, the data's `sides` (lists worked out for the window; picking an item moves
// there; a side's `choice` is sent as a parameter of the next request). A front plugin can also put its
// own panel there (slot "grid-side:<grid>": it gets `centre` and may emit `pick` with a cell).
import { computed, onActivated, reactive, ref, shallowRef, watch } from 'vue';
import type { ClientState } from '../../src/shared/api';
import type { GridCell, GridData } from '../../src/shared/ui';
import { useGame } from '../core/game';
import ActionLabel from './ActionLabel.vue';
import { runAction } from './actions';
import Line from './Line.vue';
import { uiText } from './text';

const props = defineProps<{ view: string; grid: string; radius?: number }>();
const game = useGame('widgets');
const { Outlet } = game.use('forms');
const data = shallowRef<GridData | null>(null);
const centre = ref<{ x: number; y: number } | null>(null);
const selected = ref<{ x: number; y: number } | null>(null);
const goto = ref({ x: '', y: '' });
/** The sides' choices (e.g. how far to look), sent with each request. */
const sideParams = reactive<Record<string, string>>({});

const wrapX = (v: number) =>
	data.value?.wrap ? ((((v - data.value.minX) % data.value.width) + data.value.width) % data.value.width) + data.value.minX : v;
const wrapY = (v: number) =>
	data.value?.wrap ? ((((v - data.value.minY) % data.value.height) + data.value.height) % data.value.height) + data.value.minY : v;
const cells = computed(() => new Map((data.value?.cells ?? []).map((c) => [`${c.x},${c.y}`, c])));
const r = computed(() => data.value?.radius ?? props.radius ?? 7);
// Rows from the top (highest y) down.
const rows = computed(() => {
	const d = data.value;
	if (!d) return [];
	return Array.from({ length: 2 * r.value + 1 }, (_, i) =>
		Array.from({ length: 2 * r.value + 1 }, (_, j) => ({ x: wrapX(d.centre.x + j - r.value), y: wrapY(d.centre.y - i + r.value) })),
	);
});
const cellAt = (t: { x: number; y: number }) => cells.value.get(`${t.x},${t.y}`);
const selectedCell = computed(() => (selected.value ? cellAt(selected.value) : undefined));
const tooltip = (c: GridCell | undefined, t: { x: number; y: number }) =>
	`${(c?.title ?? []).map((x) => uiText(game, x)).join(' · ')} (${t.x}, ${t.y})`.trim();

async function load() {
	const q = new URLSearchParams({ ...game.params, ...sideParams, views: props.view, r: String(props.radius ?? 7) });
	if (centre.value) {
		q.set('x', String(centre.value.x));
		q.set('y', String(centre.value.y));
	}
	const state = await game.request<ClientState>(`/api/state?${q}`);
	data.value = (state.views[props.view] as GridData | undefined) ?? null;
	if (!centre.value && data.value) centre.value = data.value.centre;
}
const move = (dx: number, dy: number) => centre.value && (centre.value = { x: wrapX(centre.value.x + dx), y: wrapY(centre.value.y + dy) });
function home() {
	if (data.value?.home) centre.value = { ...data.value.home };
}
function jump() {
	const x = Number(goto.value.x);
	const y = Number(goto.value.y);
	if (Number.isInteger(x) && Number.isInteger(y)) centre.value = { x: wrapX(x), y: wrapY(y) };
}
/** A cell picked elsewhere (a side panel): centre on it and select it. */
function pick(t: { x: number; y: number }) {
	centre.value = { x: t.x, y: t.y };
	selected.value = t;
}
watch([centre, sideParams], load, { immediate: true });
// Anything may have changed (e.g. a settlement was just founded): fetch the window again.
watch(() => game.state.value, load);
onActivated(load);
</script>

<template>
	<section v-if="data" class="card grid-map">
		<div class="controls row">
			<button type="button" class="small secondary" @click="move(-5, 0)">◀</button>
			<button type="button" class="small secondary" @click="move(0, 5)">▲</button>
			<button type="button" class="small secondary" @click="move(0, -5)">▼</button>
			<button type="button" class="small secondary" @click="move(5, 0)">▶</button>
			<button v-if="data.home" type="button" class="small secondary" @click="home">{{ game.t('My settlement') }}</button>
			<form class="row goto" @submit.prevent="jump">
				<input v-model="goto.x" inputmode="numeric" placeholder="x" aria-label="x" />
				<input v-model="goto.y" inputmode="numeric" placeholder="y" aria-label="y" />
				<button type="submit" class="small secondary">{{ game.t('Go') }}</button>
			</form>
			<small class="muted">({{ data.centre.x }}, {{ data.centre.y }})</small>
		</div>
		<div class="board">
			<div class="cells" :style="{ gridTemplateColumns: `repeat(${2 * r + 1}, 1fr)` }">
				<template v-for="row in rows" :key="row[0].y">
					<button
						v-for="t in row"
						:key="`${t.x},${t.y}`"
						type="button"
						class="cell"
						:class="[cellAt(t)?.tone, { selected: selected?.x === t.x && selected?.y === t.y }]"
						:style="{ background: cellAt(t)?.fill ? `var(--${cellAt(t)!.fill}, var(--input-bg))` : undefined }"
						:title="tooltip(cellAt(t), t)"
						@click="selected = t"
					>
						{{ cellAt(t)?.icon ?? '' }}
					</button>
				</template>
			</div>
			<aside v-for="(side, k) in data.sides ?? []" :key="k" class="side">
				<div class="side-head">
					<strong>{{ uiText(game, side.title) }}</strong>
					<select
						v-if="side.choice"
						:value="side.choice.selected"
						@change="sideParams[side.choice.param] = ($event.target as HTMLSelectElement).value"
					>
						<option v-for="o in side.choice.options" :key="o.value" :value="o.value">{{ uiText(game, o.label) }}</option>
					</select>
				</div>
				<Line v-for="(l, i) in side.notes ?? []" :key="`n${i}`" :line="l" />
				<p v-if="!side.items.length && side.empty" class="muted">{{ uiText(game, side.empty) }}</p>
				<ul v-else class="side-list">
					<li v-for="(it, i) in side.items" :key="i">
						<button type="button" class="side-item" @click="pick(it.at)">
							<span>{{ uiText(game, it.label) }}</span>
							<small v-for="(s, j) in it.sub ?? []" :key="j" class="muted">{{ uiText(game, s) }}</small>
						</button>
					</li>
				</ul>
			</aside>
			<component
				:is="s.component"
				v-for="(s, i) in game.slot(`grid-side:${grid}`)"
				:key="i"
				v-bind="s.props"
				:centre="data.centre"
				@pick="pick"
			/>
		</div>
		<ul v-if="data.legend?.length" class="legend">
			<li v-for="l in data.legend" :key="l.fill">
				<span class="swatch" :style="{ background: `var(--${l.fill}, var(--input-bg))` }"></span>{{ uiText(game, l.label) }}
			</li>
		</ul>
	</section>

	<section v-if="data && selected" class="card cell-info">
		<h2>{{ game.t('Tile ({x}, {y})', { x: selected.x, y: selected.y }) }}</h2>
		<Line v-for="(l, i) in selectedCell?.info ?? []" :key="i" :line="l" />
		<div v-if="selectedCell?.actions?.length" class="row">
			<button v-for="(a, i) in selectedCell.actions" :key="i" type="button" class="small" @click="runAction(game, a)">
				<ActionLabel :action="a" />
			</button>
		</div>
	</section>
	<div v-if="data?.placement && selected" class="forms">
		<component :is="Outlet" :placement="data.placement" :context="{ x: String(selected.x), y: String(selected.y) }" />
	</div>
</template>

<style scoped>
.grid-map {
	display: grid;
	gap: 12px;
}

.goto input {
	width: 64px;
	padding: 4px 8px;
}

.board {
	display: flex;
	flex-wrap: wrap;
	gap: 16px;
	align-items: flex-start;
}

.side {
	flex: 1 1 240px;
	min-width: 0;
	display: grid;
	gap: 6px;
	align-content: start;
}

.side-head {
	display: flex;
	gap: 8px;
	align-items: center;
	justify-content: space-between;
}

.side-head select {
	width: auto;
	padding: 2px 6px;
}

.side-list {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 4px;
	max-height: 480px;
	overflow-y: auto;
}

.side-item {
	width: 100%;
	display: flex;
	gap: 8px;
	align-items: baseline;
	text-align: left;
	background: none;
	color: inherit;
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 4px 8px;
}

.side-item small:last-child {
	margin-left: auto;
	font-variant-numeric: tabular-nums;
}

.cells {
	flex: 1 1 360px;
	display: grid;
	gap: 2px;
	max-width: 600px;
}

.cell {
	aspect-ratio: 1;
	padding: 0;
	border-radius: 3px;
	background: var(--input-bg);
	color: var(--text);
	border: 1px solid var(--border);
	font-size: clamp(10px, 2.4vw, 18px);
	line-height: 1;
}

.cell.occupied {
	border: 2px solid var(--muted);
}

.cell.mine {
	border: 2px solid var(--accent);
}

.cell.enemy {
	border: 2px solid var(--danger);
}

.cell.marked {
	border: 2px solid var(--info);
}

.cell.selected {
	outline: 2px solid var(--text);
	outline-offset: -2px;
}

.legend {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-wrap: wrap;
	gap: 4px 12px;
	font-size: 0.85em;
	color: var(--muted);
}

.legend li {
	display: flex;
	align-items: center;
	gap: 4px;
}

.swatch {
	width: 12px;
	height: 12px;
	border-radius: 3px;
	border: 1px solid var(--border);
}

.cell-info {
	display: grid;
	gap: 6px;
}

.cell-info h2 {
	margin: 0;
}

.forms {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
	gap: 16px;
}
</style>
