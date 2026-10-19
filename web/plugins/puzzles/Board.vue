<script setup lang="ts">
// The puzzles a player is putting together (docs/design/gameplay.md §13.4), in the Music House: the list, and the chosen
// one's grid — collected pieces show the picture, missing ones the same picture blurred and dimmed (cut and blurred
// here, from one picture the browser keeps). What it is comes from the static catalog, the pieces from the view.
import { computed, ref } from 'vue';
import type { PuzzleInfo, PuzzleProgress } from '../../../src/shared/api';
import { useGame } from '../../core/game';

const props = defineProps<{ view?: string; catalog?: string }>();
const game = useGame('puzzles');
const settlement = game.use('settlement');
const catalog = computed(() => game.static<Record<string, PuzzleInfo>>(props.catalog ?? 'puzzles.catalog') ?? {});
const mine = computed(() => (game.view('puzzles.mine') ?? []) as PuzzleProgress[]);
const list = computed(() => mine.value.flatMap((m) => (catalog.value[m.id] ? [{ ...m, info: catalog.value[m.id] }] : [])));
const chosen = ref<string | null>(null);
const shown = computed(() => list.value.find((p) => p.id === chosen.value) ?? list.value[0] ?? null);

const pieceName = (grid: number, i: number) => `${String.fromCharCode(65 + Math.floor(i / grid))}${(i % grid) + 1}`;
const cells = computed(() => {
	const p = shown.value;
	if (!p) return [];
	const n = p.info.grid;
	const have = new Set(p.pieces);
	const url = p.info.image ? game.fileUrl(p.info.image) : null;
	return Array.from({ length: n * n }, (_, i) => {
		const row = Math.floor(i / n);
		const col = i % n;
		return {
			i,
			name: pieceName(n, i),
			have: have.has(i),
			style: url
				? {
						backgroundImage: `url("${url}")`,
						backgroundSize: `${n * 100}% ${n * 100}%`,
						backgroundPosition: `${n > 1 ? (col / (n - 1)) * 100 : 0}% ${n > 1 ? (row / (n - 1)) * 100 : 0}%`,
					}
				: {},
		};
	});
});
const complete = computed(() => !!shown.value && shown.value.pieces.length >= shown.value.info.grid * shown.value.info.grid);
const left = computed(() => (shown.value ? shown.value.info.limit - shown.value.claims : 0));
// A reward aimed at a settlement: the player picks one of theirs (default: the one they are looking at); the server checks it.
const target = ref<string | null>(null);
const targetId = computed(() => target.value ?? settlement.current.value?.id ?? null);
const claim = () =>
	shown.value &&
	game.command(
		'puzzles.claim',
		{ puzzle: shown.value.id, ...(shown.value.info.chooseSettlement && targetId.value ? { settlement: targetId.value } : {}) },
		{ pending: 'Claiming…' },
	);
</script>

<template>
	<section class="card puzzles">
		<h3>🧩 {{ game.t('Puzzles') }}</h3>
		<p v-if="!list.length" class="muted">{{ game.t('No puzzle pieces yet: they drop in battles.') }}</p>
		<template v-else>
			<nav class="list">
				<button v-for="p in list" :key="p.id" type="button" :class="{ active: shown?.id === p.id }" @click="chosen = p.id">
					{{ p.info.name }} · {{ p.pieces.length }} / {{ p.info.grid * p.info.grid }}
				</button>
			</nav>
			<div v-if="shown" class="board" :style="{ gridTemplateColumns: `repeat(${shown.info.grid}, 1fr)` }">
				<div v-for="c in cells" :key="c.i" class="cell">
					<div class="pic" :class="{ missing: !c.have, plain: !shown.info.image }" :style="c.style"></div>
					<span v-if="!c.have" class="name">{{ c.name }}</span>
				</div>
			</div>
			<div v-if="shown" class="about">
				<p>{{ game.t('Completing it brings:') }}</p>
				<ul>
					<li v-for="(r, i) in shown.info.rewards" :key="i">{{ game.t(r) }}</li>
				</ul>
				<p v-if="shown.info.duplicate" class="muted">
					{{ game.t('A piece you have already turns into:') }} {{ game.t(shown.info.duplicate) }}
				</p>
				<p class="muted">{{ game.t('Claimed {n} of {max} times', { n: shown.claims, max: shown.info.limit }) }}</p>
				<p v-if="!shown.info.dropping" class="muted">{{ game.t('Its pieces no longer drop.') }}</p>
				<label v-if="shown.info.chooseSettlement" class="target">
					{{ game.t('For the settlement') }}
					<select :value="targetId ?? ''" @change="target = ($event.target as HTMLSelectElement).value">
						<option v-for="s in settlement.list.value" :key="s.id" :value="s.id">
							{{ game.t(s.name) }} · {{ settlement.kindName(s.kind) }} ({{ s.x }}, {{ s.y }})
						</option>
					</select>
				</label>
				<button type="button" :disabled="!complete || left <= 0 || (!!shown.info.chooseSettlement && !targetId)" @click="claim">
					{{ game.t('Claim the reward') }}
				</button>
			</div>
		</template>
	</section>
</template>

<style scoped>
.puzzles {
	display: grid;
	gap: 10px;
}

h3 {
	margin: 0;
}

.list {
	display: flex;
	flex-wrap: wrap;
	gap: 6px;
}

.list button.active {
	border-color: var(--accent);
	color: var(--text);
}

.board {
	display: grid;
	gap: 2px;
	max-width: 420px;
	aspect-ratio: 1;
	background: var(--border);
	border-radius: var(--radius);
	overflow: hidden;
}

.cell {
	position: relative;
	overflow: hidden;
}

.pic {
	position: absolute;
	inset: 0;
	background-color: var(--surface);
	background-repeat: no-repeat;
}

/* The "blurred mask": the same piece of the picture, blurred and dimmed (drawn here, not stored). */
.pic.missing {
	filter: blur(3px) brightness(0.55);
}

.pic.plain.missing {
	filter: none;
	background-color: var(--bg);
}

.name {
	position: absolute;
	inset: 0;
	display: grid;
	place-items: center;
	font-size: 0.8rem;
	color: var(--text);
}

.target {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px;
	margin: 6px 0;
}

.about p {
	margin: 4px 0;
}

.muted {
	color: var(--muted);
}
</style>
