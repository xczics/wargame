<script setup lang="ts">
import { computed, ref } from 'vue';
import type { BuildingEffects, BuildOption, SlotInfo } from '../../../src/shared/api';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

/** `detailed`: shown inside the building's own entry, so the title does not open it again. */
const props = defineProps<{ settlement: string; district: string; info: SlotInfo; detailed?: boolean }>();
const game = useGame();
const resources = game.use('resources');
const buildings = new Map((game.meta.buildings ?? []).map((b) => [b.id, b]));
const icons = new Map((game.meta.resources ?? []).map((r) => [r.id, r.icon ?? r.id]));
const names = new Map((game.meta.resources ?? []).map((r) => [r.id, r.name]));
const statNames = new Map((game.meta.stats ?? []).map((s) => [s.id, s.description]));

/** "🌾 +3/s", "+2000 storage cap" … */
const effectText = (e: BuildingEffects) => [
	...Object.entries(e.produces).map(([r, n]) => `${icons.get(r) ?? r} +${formatNumber(n, { decimals: 1 })}/s`),
	...Object.entries(e.stats).map(([s, n]) => `+${formatNumber(n, { decimals: 2 })} ${game.t(statNames.get(s) ?? s)}`),
];
const picking = ref(false);

const name = (id: string) => game.t(buildings.get(id)?.name ?? id);
const icon = (id: string) => buildings.get(id)?.icon ?? '🏗️';
const duration = (s: number) =>
	s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;

const remaining = computed(() => {
	const c = props.info.construction;
	return c ? Math.max(0, Math.ceil((c.finishesAt - game.serverNow()) / 1000)) : 0;
});
const progress = computed(() => {
	const c = props.info.construction;
	return c ? Math.min(100, ((game.serverNow() - c.startedAt) / (c.finishesAt - c.startedAt)) * 100) : 0;
});
const canStart = (o: BuildOption) => !o.blocked && resources.canAfford(o.cost);
const short = (r: string | number, n: number) => resources.current(String(r)) < n;
/** Tooltip explaining a disabled button: the block reason or what is missing. */
const why = (o: BuildOption) =>
	(o.blocked && game.t(o.blocked)) ||
	Object.entries(o.cost)
		.filter(([r, n]) => short(r, n))
		.map(([r, n]) => game.t('Need {n} more {r}', { n: Math.ceil(n - resources.current(r)), r: game.t(names.get(r) ?? r) }))
		.join(', ');

/** The building in this slot (built or being built), opened as an entry in the right column. */
const building = computed(() => props.info.current?.building ?? props.info.construction?.building);
function open() {
	if (!building.value) return;
	game.openEntry({
		kind: 'building',
		id: `${props.settlement}/${props.district}/${props.info.slot}`,
		type: building.value,
		label: buildings.get(building.value)?.name ?? building.value,
		data: { settlement: props.settlement, district: props.district, slot: String(props.info.slot) },
	});
}

async function cancel() {
	if (!confirm(game.t('Cancel this construction? Only part of the cost is refunded.'))) return;
	await game.command('buildings.cancel', { settlement: props.settlement, district: props.district, slot: props.info.slot });
}

async function start(o: BuildOption) {
	const ok = await game.command('buildings.construct', {
		settlement: props.settlement,
		district: props.district,
		slot: props.info.slot,
		building: o.building,
	});
	if (ok) picking.value = false;
}
</script>

<template>
	<div class="slot" :class="{ empty: !info.current && !info.construction }">
		<component
			:is="building && !detailed ? 'button' : 'div'"
			type="button"
			class="title"
			:class="{ open: building && !detailed }"
			@click="!detailed && open()"
		>
			<template v-if="info.current">
				<span class="icon">{{ icon(info.current.building) }}</span>
				<strong>{{ name(info.current.building) }}</strong>
				<small>Lv {{ info.current.level }}/{{ info.current.cap }}</small>
			</template>
			<template v-else-if="info.construction">
				<span class="icon">🏗️</span>
				<strong>{{ name(info.construction.building) }}</strong>
			</template>
			<small v-else class="muted">{{ game.t('Empty slot {n}', { n: info.slot + 1 }) }}</small>
		</component>

		<small v-if="info.current && effectText(info.current.effects).length" class="effects"
			>{{ game.t('Now:') }} {{ effectText(info.current.effects).join(' · ') }}</small
		>

		<div v-if="info.construction" class="building">
			<small>→ Lv {{ info.construction.targetLevel }} · {{ remaining > 0 ? duration(remaining) : game.t('finishing…') }}</small>
			<div class="bar"><div :style="{ width: `${progress}%` }"></div></div>
			<button type="button" class="link" @click="cancel">{{ game.t('Cancel') }}</button>
		</div>

		<template v-else-if="info.current">
			<template v-for="o in info.options" :key="o.building">
				<button type="button" class="small" :disabled="!canStart(o)" :title="why(o) || undefined" @click="start(o)">
					{{ game.t('Upgrade') }} ·
					<span v-for="(n, r) in o.cost" :key="r" class="part" :class="{ short: short(r, n) }"
						>{{ icons.get(String(r)) }}{{ formatNumber(n) }}</span
					>
					·
					{{ duration(o.seconds) }}
				</button>
				<small v-if="effectText(o.effects).length" class="effects">Lv {{ o.level }}: {{ effectText(o.effects).join(' · ') }}</small>
				<small v-if="o.blocked" class="blocked">{{ game.t(o.blocked) }}</small>
			</template>
		</template>

		<template v-else>
			<button v-if="!picking" type="button" class="small secondary" @click="picking = true">{{ game.t('Build…') }}</button>
			<ul v-else class="choices">
				<li v-for="o in info.options" :key="o.building">
					<button type="button" class="small" :disabled="!canStart(o)" :title="why(o) || undefined" @click="start(o)">
						{{ icon(o.building) }} {{ name(o.building) }}
					</button>
					<small v-if="effectText(o.effects).length" class="effects">{{ effectText(o.effects).join(' · ') }}</small>
					<small>
						<span v-for="(n, r) in o.cost" :key="r" class="part" :class="{ short: short(r, n) }"
							>{{ icons.get(String(r)) }}{{ formatNumber(n) }}</span
						>
						·
						{{ duration(o.seconds) }}
						<span v-if="o.blocked" class="blocked"> · {{ game.t(o.blocked) }}</span>
					</small>
				</li>
				<li>
					<button type="button" class="link" @click="picking = false">{{ game.t('Cancel') }}</button>
				</li>
			</ul>
		</template>
	</div>
</template>

<style scoped>
.slot {
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 10px;
	display: grid;
	gap: 8px;
	align-content: start;
	background: var(--surface);
}

.slot.empty {
	border-style: dashed;
}

.title {
	display: flex;
	gap: 6px;
	align-items: baseline;
}

.title.open {
	background: none;
	color: inherit;
	padding: 0;
	border-radius: 0;
	cursor: pointer;
}

.title.open:hover strong {
	text-decoration: underline;
}

.icon {
	font-size: 1.2em;
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
	transition: width 0.1s linear;
}

.choices {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 6px;
}

.choices li {
	display: grid;
	gap: 2px;
}

.effects {
	color: var(--info);
}

.part + .part {
	margin-left: 6px;
}

.blocked,
.short {
	color: var(--danger);
	font-weight: 600;
}

button {
	justify-self: start;
	text-align: left;
}
</style>
