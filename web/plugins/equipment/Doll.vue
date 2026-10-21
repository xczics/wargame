<script setup lang="ts">
// Widget "equipment.doll": the equipment screen as a paper doll (`equipment.doll`). In a pixel "game screen": the
// chosen hero's figure wearing what it wears, the regular slots framed on both sides, the heroine's accessory slots
// below; then the settlement's stored pieces as a bag of tiles with the storage filters. Pointing at (or tapping) a
// piece shows its card with its buttons.
import { computed, onBeforeUnmount, ref } from 'vue';
import type { EquipmentDollPiece } from '../../../src/shared/api';
import type { UiAction } from '../../../src/shared/ui';
import { useGame } from '../../core/game';
import { dollLayers, slotColumns } from './art';
import PixelArt from './PixelArt.vue';
import { type Box, fitScale, type PixelLayer } from './pixels';

const props = defineProps<{ view: string }>();
const game = useGame('equipment');
const data = computed(() => game.view(props.view as 'equipment.doll'));
const art = game.use('equipment').art;
const gender = computed(() => data.value?.hero?.gender ?? 'm');

/* ----- art ----- */
const pieceArt = (p: EquipmentDollPiece, g = gender.value) =>
	art.value?.piece({ slot: p.slot, set: p.set?.id, rarity: p.rarity }, g) ?? null;
const figureLayers = computed((): PixelLayer[] => {
	const a = art.value;
	const d = data.value;
	if (!a || !d?.hero) return [];
	const worn = [...d.slots.flatMap((s) => (s.piece ? [s.piece] : [])), ...(d.accessories?.worn ?? [])];
	return dollLayers(
		a.figure(gender.value),
		worn.map((p) => pieceArt(p)),
	);
});
const FRAME = 40;
const TILE = 40;
// A piece's icon: its crop of the sprite (with the figure under it where the art says so), at a whole scale.
function icon(p: EquipmentDollPiece, size: number): { layers: PixelLayer[]; box: Box; scale: number } | null {
	const a = art.value;
	const pa = pieceArt(p);
	if (!a || !pa) return null;
	const layers = [...(pa.back ? [pa.back] : []), ...(pa.iconFigure ? [a.figure(pa.iconFigure)] : []), pa.front];
	return { layers, box: pa.icon, scale: fitScale(pa.icon, size) };
}
const columns = computed(() => slotColumns(data.value?.slots ?? [], (id) => art.value?.side(id)));
const accessorySlots = computed(() => {
	const acc = data.value?.accessories;
	return acc ? Array.from({ length: acc.limit }, (_, i) => acc.worn[i] ?? null) : [];
});

/* ----- storage filters ----- */
const facetPick = ref<Record<string, string>>({});
const stored = computed(() =>
	(data.value?.storage.pieces ?? []).filter((p) => Object.entries(facetPick.value).every(([id, v]) => !v || p.facets?.[id] === v)),
);

/* ----- the piece's card ----- */
const root = ref<HTMLElement | null>(null);
const tip = ref<{ piece: EquipmentDollPiece; left: number; top: number; pinned: boolean } | null>(null);
let hideTimer: ReturnType<typeof setTimeout> | undefined;
const CARD_W = 240;
function show(piece: EquipmentDollPiece, ev: Event, pinned = false) {
	clearTimeout(hideTimer);
	const host = root.value?.getBoundingClientRect();
	const at = (ev.currentTarget as HTMLElement).getBoundingClientRect();
	if (!host) return;
	const left = Math.max(8, Math.min(at.left - host.left + at.width / 2 - CARD_W / 2, host.width - CARD_W - 8));
	tip.value = { piece, left, top: at.bottom - host.top + 6, pinned };
}
function hover(piece: EquipmentDollPiece, ev: Event) {
	if (!tip.value?.pinned) show(piece, ev);
}
function leave() {
	if (tip.value && !tip.value.pinned) hideTimer = setTimeout(() => (tip.value = null), 150);
}
function tap(piece: EquipmentDollPiece, ev: Event) {
	if (tip.value?.pinned && tip.value.piece.id === piece.id) tip.value = null;
	else show(piece, ev, true);
}
const keep = () => clearTimeout(hideTimer);
onBeforeUnmount(() => clearTimeout(hideTimer));

/* ----- buttons ----- */
const busy = ref(false);
async function run(a: UiAction) {
	if (a.blocked || busy.value) return;
	if (a.confirm && !confirm(game.t(a.confirm))) return;
	if (a.entry) {
		tip.value = null;
		return game.openEntry(a.entry);
	}
	if (!a.command) return;
	busy.value = true;
	try {
		const ok = await game.command(a.command, a.payload ?? {}, { pending: game.t('{0}: working…', { 0: game.t(a.label) }) });
		if (ok) tip.value = null;
	} finally {
		busy.value = false;
	}
}
const rarityClass = (p: EquipmentDollPiece | null | undefined) => (p ? `r-${p.rarity}` : 'empty');
</script>

<template>
	<section v-if="data" ref="root" class="card doll" @keydown.esc="tip = null">
		<header>
			<h2>{{ game.t(data.title) }}</h2>
			<select
				v-if="data.picker?.options.length"
				:value="data.picker.selected"
				@change="game.setParam(data.picker.param, ($event.target as HTMLSelectElement).value)"
			>
				<option v-for="o in data.picker.options" :key="o.value" :value="o.value">{{ game.t(o.label) }}</option>
			</select>
		</header>

		<div v-if="data.hero" class="screen">
			<div class="stage">
				<div v-for="(col, side) in columns" :key="side" class="slots" :class="side">
					<div v-for="s in col" :key="s.id" class="slot">
						<button
							type="button"
							class="frame"
							:class="rarityClass(s.piece)"
							:aria-label="s.piece ? game.t({ text: s.piece.name }) : game.t(s.name)"
							@mouseenter="s.piece && hover(s.piece, $event)"
							@mouseleave="leave"
							@focus="s.piece && hover(s.piece, $event)"
							@blur="leave"
							@click="s.piece && tap(s.piece, $event)"
						>
							<template v-if="s.piece && icon(s.piece, FRAME)">
								<PixelArt v-bind="icon(s.piece, FRAME)!" />
							</template>
							<span v-else-if="s.piece" class="glyph">◆</span>
						</button>
						<small class="caption" :class="s.piece ? `rarity rarity-${s.piece.rarity}` : ''">
							{{ s.piece ? game.t({ text: s.piece.name }) : game.t(s.name) }}
						</small>
					</div>
				</div>
				<div class="figure">
					<PixelArt v-if="figureLayers.length && art" :layers="figureLayers" :box="[0, 0, art.size[0], art.size[1]]" />
					<small class="level">{{ game.t(data.hero.level) }}</small>
				</div>
			</div>
			<div v-if="data.accessories" class="accessories">
				<h3>{{ game.t(data.accessories.title) }}</h3>
				<div class="grid">
					<button
						v-for="(p, i) in accessorySlots"
						:key="p?.id ?? `empty${i}`"
						type="button"
						class="frame small"
						:class="rarityClass(p)"
						:title="p ? undefined : game.t(data.accessories.empty)"
						:aria-label="p ? game.t({ text: p.name }) : game.t('Empty slot')"
						@mouseenter="p && hover(p, $event)"
						@mouseleave="leave"
						@focus="p && hover(p, $event)"
						@blur="leave"
						@click="p && tap(p, $event)"
					>
						<template v-if="p && icon(p, TILE)">
							<PixelArt v-bind="icon(p, TILE)!" />
						</template>
						<span v-else-if="p" class="glyph">◆</span>
					</button>
				</div>
			</div>
		</div>

		<div class="storage">
			<h3>
				{{ game.t(data.storage.title) }}
				<button v-for="(a, i) in data.storage.actions" :key="i" type="button" class="small secondary" @click="run(a)">
					{{ game.t(a.label) }}
				</button>
			</h3>
			<div v-if="data.facets?.length" class="facets">
				<label v-for="f in data.facets" :key="f.id">
					{{ game.t(f.label) }}
					<select :value="facetPick[f.id] ?? ''" @change="facetPick[f.id] = ($event.target as HTMLSelectElement).value">
						<option v-for="o in f.options" :key="o.value" :value="o.value">{{ game.t(o.label) }}</option>
					</select>
				</label>
			</div>
			<div v-if="stored.length" class="screen bag">
				<button
					v-for="p in stored"
					:key="p.id"
					type="button"
					class="frame small"
					:class="[rarityClass(p), { low: p.tooLow }]"
					:aria-label="game.t({ text: p.name })"
					@mouseenter="hover(p, $event)"
					@mouseleave="leave"
					@focus="hover(p, $event)"
					@blur="leave"
					@click="tap(p, $event)"
				>
					<template v-if="icon(p, TILE)">
						<PixelArt v-bind="icon(p, TILE)!" />
					</template>
					<span v-else class="glyph">◆</span>
				</button>
			</div>
			<p v-if="data.storage.empty" class="muted">{{ game.t(data.storage.empty) }}</p>
		</div>

		<div v-if="tip" class="tip" :style="{ left: `${tip.left}px`, top: `${tip.top}px` }" @mouseenter="keep" @mouseleave="leave">
			<strong :class="`rarity rarity-${tip.piece.rarity}`">{{ game.t({ text: tip.piece.name }) }}</strong>
			<small>
				{{ game.t(tip.piece.rarityName) }} · {{ game.t(tip.piece.slotName)
				}}<template v-if="tip.piece.set"> · {{ game.t(tip.piece.set.name) }}</template>
			</small>
			<ul v-if="tip.piece.stats.length">
				<li v-for="(s, i) in tip.piece.stats" :key="i">{{ game.t(s) }}</li>
			</ul>
			<small v-if="tip.piece.minLevel" :class="{ warn: tip.piece.tooLow }">{{
				game.t('Needs level {0}', { 0: tip.piece.minLevel })
			}}</small>
			<div class="actions">
				<button
					v-for="(a, i) in tip.piece.actions"
					:key="i"
					type="button"
					class="small"
					:class="{ secondary: a.command === 'equipment.smelt' }"
					:disabled="!!a.blocked || busy"
					:title="a.blocked ? game.t(a.blocked) : undefined"
					@click="run(a)"
				>
					{{ game.t(a.label) }}
				</button>
			</div>
		</div>
	</section>
</template>

<style scoped>
.doll {
	position: relative;
}

header {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	justify-content: space-between;
	gap: 8px;
	margin-bottom: 10px;
}

header h2 {
	margin: 0;
}

header select {
	width: auto;
	max-width: 100%;
}

/* The pixel "game screen": a dark stage in a stepped frame, in either theme. */
.screen {
	--px: 3;
	background: radial-gradient(ellipse at 50% 40%, var(--screen-glow), var(--screen-bg) 70%);
	color: var(--screen-ink);
	border: 3px solid var(--screen-edge);
	box-shadow:
		0 0 0 3px var(--screen-frame),
		inset 0 0 0 2px var(--screen-inner);
	border-radius: 2px;
	margin: 3px 3px 14px;
	padding: 12px;
}

.stage {
	display: grid;
	grid-template-columns: 1fr auto 1fr;
	align-items: center;
	gap: 8px;
}

.slots {
	display: grid;
	gap: 10px;
	align-content: center;
}

.slots.left {
	justify-items: end;
	order: 0;
}

.slots.right {
	justify-items: start;
	order: 2;
}

.figure {
	order: 1;
	display: grid;
	justify-items: center;
	gap: 4px;
	padding-bottom: 4px;
	background: radial-gradient(ellipse 45% 6% at 50% 96%, var(--screen-shadow), transparent);
}

.slot {
	display: grid;
	justify-items: center;
	gap: 3px;
	width: 84px;
}

.caption {
	color: var(--screen-muted);
	font-size: 0.72em;
	text-align: center;
	line-height: 1.2;
	overflow: hidden;
	text-overflow: ellipsis;
	display: -webkit-box;
	-webkit-line-clamp: 2;
	line-clamp: 2;
	-webkit-box-orient: vertical;
}

.level {
	color: var(--screen-ink);
	font-weight: 700;
}

/* A slot: a dark well with a stepped edge; the rarity colours the edge (and makes the rarer ones glow). */
.frame {
	--edge: var(--screen-edge);
	width: 52px;
	height: 52px;
	padding: 0;
	display: grid;
	place-items: center;
	background: var(--slot-bg);
	border: 2px solid var(--edge);
	border-radius: 0;
	box-shadow:
		inset 0 0 0 2px var(--slot-inner),
		0 2px 0 0 var(--screen-frame);
	color: var(--screen-muted);
}

.frame.small {
	width: 48px;
	height: 48px;
}

.frame.empty {
	border-style: dashed;
	background: transparent;
	cursor: default;
}

.frame:not(.empty):hover,
.frame:not(.empty):focus-visible {
	outline: 2px solid var(--screen-ink);
	outline-offset: 1px;
}

.frame.r-white {
	--edge: var(--rarity-white);
}
.frame.r-green {
	--edge: var(--rarity-green);
}
.frame.r-blue {
	--edge: var(--rarity-blue);
	box-shadow:
		inset 0 0 0 2px var(--slot-inner),
		0 0 6px var(--rarity-blue);
}
.frame.r-gold {
	--edge: var(--rarity-gold);
	box-shadow:
		inset 0 0 0 2px var(--slot-inner),
		0 0 8px var(--rarity-gold);
}
.frame.r-purple {
	--edge: var(--rarity-purple);
	box-shadow:
		inset 0 0 0 2px var(--slot-inner),
		0 0 10px var(--rarity-purple);
}

.frame.low {
	opacity: 0.55;
}

.glyph {
	font-size: 1.2em;
}

.accessories h3,
.storage h3 {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 8px;
	margin: 12px 0 8px;
	font-size: 0.95em;
}

.accessories h3 {
	color: var(--screen-ink);
	justify-content: center;
}

.accessories .grid {
	display: grid;
	grid-template-columns: repeat(5, 48px);
	justify-content: center;
	gap: 8px;
}

.facets {
	display: flex;
	flex-wrap: wrap;
	gap: 8px 12px;
	margin-bottom: 8px;
}

.facets select {
	width: auto;
}

.bag {
	display: grid;
	grid-template-columns: repeat(auto-fill, 48px);
	gap: 6px;
	padding: 10px;
}

.tip {
	position: absolute;
	z-index: 5;
	width: 240px;
	display: grid;
	gap: 4px;
	padding: 10px 12px;
	background: var(--surface);
	color: var(--text);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	box-shadow: 0 6px 18px var(--scrim);
}

.tip ul {
	margin: 2px 0;
	padding-left: 18px;
	font-size: 0.9em;
}

.tip .warn {
	color: var(--danger);
}

.tip .actions {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
	margin-top: 4px;
}

@media (max-width: 480px) {
	.screen {
		--px: 2;
		padding: 8px;
	}

	.slot {
		width: 64px;
	}

	.accessories .grid {
		grid-template-columns: repeat(5, 44px);
		gap: 6px;
	}

	.frame.small {
		width: 44px;
		height: 44px;
	}
}
</style>
