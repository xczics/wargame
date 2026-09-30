<script setup lang="ts">
import { computed, onActivated, ref, shallowRef, watch } from 'vue';
import type { ClientState, MapTile, TerrainWindow } from '../../../src/shared/api';
import { useGame } from '../../core/game';

const RADIUS = 7;
const game = useGame();
const { Outlet } = game.use('forms');
const settlement = game.use('settlement');
const auth = game.use('auth');
const { min, max } = game.meta.map ?? { min: -511, max: 512 };
const size = max - min + 1;
const wrap = (v: number) => ((((v - min) % size) + size) % size) + min;

const centre = ref({ x: 0, y: 0 });
const tiles = shallowRef(new Map<string, MapTile>());
const terrain = shallowRef<TerrainWindow | null>(null);
const terrains = new Map((game.meta.terrains ?? []).map((t) => [t.code, t]));
/** Terrain of a window cell: its rows run from y - radius upwards, the map's from the top (highest y) down. */
const terrainOf = (r: number, c: number) => {
	const w = terrain.value;
	const code = w?.rows[2 * RADIUS - r]?.[c];
	return code ? terrains.get(code) : undefined;
};
const terrainStyle = (r: number, c: number) => ({
	background: `var(--terrain-${terrainOf(r, c)?.id ?? 'unknown'}, var(--terrain-unknown))`,
});
const selectedTerrain = computed(() => {
	const s = selected.value;
	if (!s) return undefined;
	const r = RADIUS - (((s.y - centre.value.y + size + RADIUS) % size) - RADIUS);
	const c = (s.x - centre.value.x + size + RADIUS) % size;
	return r >= 0 && r <= 2 * RADIUS && c >= 0 && c <= 2 * RADIUS ? terrainOf(r, c) : undefined;
});
const selected = ref<{ x: number; y: number } | null>(null);
const goto = ref({ x: '', y: '' });

const rows = computed(() =>
	Array.from({ length: 2 * RADIUS + 1 }, (_, r) =>
		Array.from({ length: 2 * RADIUS + 1 }, (_, c) => ({ x: wrap(centre.value.x + c - RADIUS), y: wrap(centre.value.y - r + RADIUS) })),
	),
);
const at = (t: { x: number; y: number }) => tiles.value.get(`${t.x},${t.y}`);
const selectedTile = computed(() => (selected.value ? at(selected.value) : undefined));
const kindIcon: Record<string, string> = { capital: '🏰', city: '🏘️', 'fortress-resource': '⛏️', 'fortress-military': '🛡️' };
const icon = (t: MapTile) => (t.centre ? (kindIcon[t.kind] ?? '☠️') : '·');

async function load() {
	const q = new URLSearchParams({
		views: 'settlements.map,terrain.window',
		x: String(centre.value.x),
		y: String(centre.value.y),
		r: String(RADIUS),
		radius: String(RADIUS),
	});
	const state = await game.request<ClientState>(`/api/state?${q}`);
	tiles.value = new Map((state.views['settlements.map'] as MapTile[]).map((t) => [`${t.x},${t.y}`, t]));
	terrain.value = (state.views['terrain.window'] as TerrainWindow | null) ?? null;
}

function home() {
	const s = settlement.current.value;
	if (s) centre.value = { x: s.x, y: s.y };
}
const move = (dx: number, dy: number) => (centre.value = { x: wrap(centre.value.x + dx), y: wrap(centre.value.y + dy) });
function jump() {
	const x = Number(goto.value.x);
	const y = Number(goto.value.y);
	if (Number.isInteger(x) && Number.isInteger(y)) centre.value = { x: wrap(x), y: wrap(y) };
}

home();
watch(centre, load, { immediate: true });
// Refresh after anything changes (e.g. a settlement was just founded here).
watch(() => game.state.value, load);
onActivated(load);
</script>

<template>
	<section class="card map">
		<div class="controls row">
			<button type="button" class="small secondary" @click="move(-5, 0)">◀</button>
			<button type="button" class="small secondary" @click="move(0, 5)">▲</button>
			<button type="button" class="small secondary" @click="move(0, -5)">▼</button>
			<button type="button" class="small secondary" @click="move(5, 0)">▶</button>
			<button type="button" class="small secondary" @click="home">{{ game.t('My settlement') }}</button>
			<form class="row goto" @submit.prevent="jump">
				<input v-model="goto.x" inputmode="numeric" placeholder="x" aria-label="x" />
				<input v-model="goto.y" inputmode="numeric" placeholder="y" aria-label="y" />
				<button type="submit" class="small secondary">{{ game.t('Go') }}</button>
			</form>
			<small class="muted">{{ game.t('centre ({x}, {y}) · the world wraps at ±512', { x: centre.x, y: centre.y }) }}</small>
		</div>
		<div class="grid" :style="{ gridTemplateColumns: `repeat(${2 * RADIUS + 1}, 1fr)` }">
			<template v-for="(row, r) in rows" :key="row[0].y">
				<button
					v-for="(t, c) in row"
					:key="`${t.x},${t.y}`"
					type="button"
					class="tile"
					:class="{
						occupied: at(t),
						mine: at(t)?.ownerId === auth.user.id,
						npc: at(t) && !at(t)!.ownerId,
						selected: selected?.x === t.x && selected?.y === t.y,
					}"
					:style="terrainStyle(r, c)"
					:title="`${at(t) ? `${at(t)!.name} ` : ''}(${t.x}, ${t.y}) ${game.t(terrainOf(r, c)?.name ?? '')}`"
					@click="selected = t"
				>
					{{ at(t) ? icon(at(t)!) : '' }}
				</button>
			</template>
		</div>
		<ul class="legend">
			<li v-for="t in game.meta.terrains ?? []" :key="t.id">
				<span class="swatch" :style="{ background: `var(--terrain-${t.id}, var(--terrain-unknown))` }"></span>{{ game.t(t.name) }}
			</li>
		</ul>
	</section>

	<section v-if="selected" class="card tile-info">
		<h2>
			{{ game.t('Tile ({x}, {y})', { x: selected.x, y: selected.y }) }}
			<small v-if="selectedTerrain"> · {{ game.t(selectedTerrain.name) }}</small>
		</h2>
		<template v-if="selectedTile">
			<p>
				<strong>{{ game.t(selectedTile.name) }}</strong> · {{ settlement.kindName(selectedTile.kind) }} ·
				{{ selectedTile.ownerId === auth.user.id ? game.t('yours') : (selectedTile.ownerName ?? 'NPC') }}
			</p>
			<button v-if="selectedTile.ownerId === auth.user.id" type="button" class="small" @click="settlement.select(selectedTile.settlement)">
				{{ game.t('Open') }}
			</button>
		</template>
		<p v-else class="muted">{{ game.t('Free land.') }}</p>
	</section>
	<div v-if="selected" class="forms">
		<component :is="Outlet" placement="tile" :context="{ x: String(selected.x), y: String(selected.y) }" />
	</div>
</template>

<style scoped>
.map {
	display: grid;
	gap: 12px;
}

.goto input {
	width: 64px;
	padding: 4px 8px;
}

.grid {
	display: grid;
	gap: 2px;
	max-width: 600px;
}

.tile {
	aspect-ratio: 1;
	padding: 0;
	border-radius: 3px;
	background: var(--input-bg);
	color: var(--text);
	border: 1px solid var(--border);
	font-size: clamp(10px, 2.4vw, 18px);
	line-height: 1;
}

.tile.occupied {
	border: 2px solid var(--muted);
}

.tile.mine {
	border-color: var(--accent);
}

.tile.npc {
	border-color: var(--danger);
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

.tile.selected {
	outline: 2px solid var(--text);
	outline-offset: -2px;
}

.tile-info p {
	margin: 0 0 8px;
}

.forms {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
	gap: 16px;
}
</style>
