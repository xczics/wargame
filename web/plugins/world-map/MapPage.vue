<script setup lang="ts">
import { computed, onActivated, ref, shallowRef, watch } from 'vue';
import type { ClientState, MapTile } from '../../../src/shared/api';
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
	const q = new URLSearchParams({ views: 'settlements.map', x: String(centre.value.x), y: String(centre.value.y), r: String(RADIUS) });
	const state = await game.request<ClientState>(`/api/state?${q}`);
	tiles.value = new Map((state.views['settlements.map'] as MapTile[]).map((t) => [`${t.x},${t.y}`, t]));
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
			<template v-for="row in rows" :key="row[0].y">
				<button
					v-for="t in row"
					:key="`${t.x},${t.y}`"
					type="button"
					class="tile"
					:class="{
						occupied: at(t),
						mine: at(t)?.ownerId === auth.user.id,
						npc: at(t) && !at(t)!.ownerId,
						selected: selected?.x === t.x && selected?.y === t.y,
					}"
					:title="at(t) ? `${at(t)!.name} (${t.x}, ${t.y})` : `(${t.x}, ${t.y})`"
					@click="selected = t"
				>
					{{ at(t) ? icon(at(t)!) : '' }}
				</button>
			</template>
		</div>
	</section>

	<section v-if="selected" class="card tile-info">
		<h2>{{ game.t('Tile ({x}, {y})', { x: selected.x, y: selected.y }) }}</h2>
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
	background: color-mix(in srgb, var(--muted) 30%, var(--input-bg));
}

.tile.mine {
	background: color-mix(in srgb, var(--accent) 45%, var(--input-bg));
}

.tile.npc {
	background: color-mix(in srgb, var(--danger) 35%, var(--input-bg));
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
