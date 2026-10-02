<script setup lang="ts">
// Left column of the City page: the settlement's districts drawn where they lie (a 3x3 grid,
// 5x5 once the second ring is used): the centre is the inner city, the cells around it the
// outer cities. Picking one shows it on the right; picking a free tile where an outer city may
// go asks whether to build one there.
import { computed } from 'vue';
import type { DistrictInfo } from '../../../src/shared/api';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';
import { districtId } from './state';

const game = useGame();
const detail = computed(() => game.view('settlements.detail'));
const { min, max } = game.meta.map ?? { min: -511, max: 512 };
const size = max - min + 1;
/** Shortest signed offset along a wrapping axis. */
const delta = (a: number, b: number) => ((((b - a) % size) + size + size / 2) % size) - size / 2;
type Cell = { district?: DistrictInfo; candidate?: { x: number; y: number }; x: number; y: number } | null;
const cells = computed<Cell[][] | null>(() => {
	const d = detail.value;
	if (!d || (d.districts.length < 2 && !d.nextOuter)) return null;
	const at = (x: number, y: number) => ({ dx: delta(d.x, x), dy: delta(d.y, y) });
	const placed: (NonNullable<Cell> & { dx: number; dy: number })[] = [
		...d.districts.map((x) => ({ district: x, x: x.x, y: x.y, ...at(x.x, x.y) })),
		...(d.nextOuter?.candidates ?? []).map((c) => ({ candidate: c, x: c.x, y: c.y, ...at(c.x, c.y) })),
	];
	const r = Math.max(1, ...placed.filter((p) => p.district).map((p) => Math.max(Math.abs(p.dx), Math.abs(p.dy))));
	// Rows from north (higher y) down, as on the map.
	return Array.from({ length: 2 * r + 1 }, (_, row) =>
		Array.from({ length: 2 * r + 1 }, (_, col) => placed.find((p) => p.dx === col - r && p.dy === r - row) ?? null),
	);
});
const terrainNames = new Map((game.meta.terrains ?? []).map((t) => [t.id, t.name]));
const resourceNames = new Map((game.meta.resources ?? []).map((r) => [r.id, r]));
const terrainOf = (c: { x: number; y: number }) => detail.value?.terrain?.[`${c.x},${c.y}`];
const terrainText = (c: { x: number; y: number }) => {
	const t = terrainOf(c);
	if (!t) return '';
	const bonus = Object.entries(t.bonus)
		.filter(([, v]) => v)
		.map(([r, v]) => `${resourceNames.get(r)?.icon ?? r}${v > 0 ? '+' : ''}${v}%`)
		.join(' ');
	return `${game.t(terrainNames.get(t.terrain) ?? t.terrain)}${bonus ? ` ${bonus}` : ''}`;
};
async function build(c: { x: number; y: number }) {
	const d = detail.value!;
	const next = d.nextOuter!;
	if (next.blocked) return game.toast(game.t(next.blocked));
	const cost = Object.entries(next.cost)
		.map(([r, n]) => `${resourceNames.get(r)?.icon ?? ''}${formatNumber(n)}`)
		.join(' ');
	const outer = d.districts.filter((x) => x.type === 'outer').length;
	const question = game.t('Build an outer city at ({x}, {y})? {terrain} · cost {cost} · outer cities {n}/{limit}', {
		x: c.x,
		y: c.y,
		terrain: terrainText(c),
		cost: cost || '—',
		n: outer + 1,
		limit: d.limits.outerTech,
	});
	if (confirm(question)) await game.command('settlements.addOuter', { settlement: d.id, x: c.x, y: c.y });
}
const current = computed(() => districtId.value || detail.value?.districts[0]?.id);
const label = (type: string, idx: number) => (type === 'inner' ? game.t('Inner city') : game.t('Outer city {n}', { n: idx }));
function pick(id: string) {
	districtId.value = id;
	if (game.entry.value) game.openEntry(null);
}
</script>

<template>
	<section v-if="cells" class="card">
		<h2>{{ game.t('Districts') }}</h2>
		<div class="grid" :style="{ gridTemplateColumns: `repeat(${cells.length}, 1fr)` }">
			<template v-for="(row, r) in cells" :key="r">
				<button
					v-for="(cell, c) in row"
					:key="c"
					type="button"
					class="cell"
					:class="{
						inner: cell?.district?.type === 'inner',
						outer: cell?.district?.type === 'outer',
						candidate: cell?.candidate,
						blocked: cell?.candidate && detail?.nextOuter?.blocked,
						active: cell?.district && cell.district.id === current,
					}"
					:disabled="!cell"
					:title="
						cell
							? `${cell.district ? label(cell.district.type, cell.district.idx) : game.t('Build an outer city here')} · ${terrainText(cell)}`
							: ''
					"
					@click="cell?.district ? pick(cell.district.id) : cell?.candidate && build(cell.candidate)"
				>
					<template v-if="cell?.district">
						<strong>{{ cell.district.type === 'inner' ? game.t('Inner') : cell.district.idx }}</strong>
						<small>{{ cell.district.slots.filter((s) => s.current).length }}/{{ cell.district.slots.length }}</small>
					</template>
					<template v-else-if="cell?.candidate">
						<strong>＋</strong>
					</template>
					<small v-if="cell" class="terrain">{{ game.t(terrainNames.get(terrainOf(cell)?.terrain ?? '') ?? '') }}</small>
				</button>
			</template>
		</div>
	</section>
</template>

<style scoped>
.grid {
	display: grid;
	gap: 4px;
	max-width: 280px;
}

.cell {
	aspect-ratio: 1;
	padding: 2px;
	display: grid;
	place-content: center;
	gap: 2px;
	background: var(--input-bg);
	color: var(--muted);
	border: 1px dashed var(--border);
	border-radius: var(--radius);
}

.cell.outer {
	color: var(--text);
	border-style: solid;
}

.cell.inner {
	color: var(--text);
	border: 2px solid var(--info);
}

.cell.candidate {
	color: var(--accent);
	border-style: dashed;
	border-color: var(--accent);
}

.cell.candidate.blocked {
	color: var(--muted);
	border-color: var(--border);
}

.terrain {
	color: var(--muted);
	font-size: 0.75em;
}

.cell.active {
	border-color: var(--accent);
	box-shadow: inset 0 0 0 2px var(--accent);
}
</style>
