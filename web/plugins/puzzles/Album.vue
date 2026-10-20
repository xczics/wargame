<script setup lang="ts">
// The album (docs/design/gameplay.md §13.4.1): an album of photographs, a spread for each puzzle the player completed
// (user 2026-10-20: "能做成'图册'的形式吗？类似照片本那种，一个大开页就是一张图"; "加点翻页效果"): the picture on the left
// page, its name, day and the GM's words on the right (AlbumPage.vue). Turning a page lifts a leaf at the fold: forward,
// the right page turns over to the left, showing the next picture on its back; backward the other way. What each is
// comes from the static catalog (retired ones stay in it for this), the claims and the first day from the view.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PuzzleAlbumEntry, PuzzleInfo } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import AlbumPage from './AlbumPage.vue';

const props = defineProps<{ entries: PuzzleAlbumEntry[]; catalog: Record<string, PuzzleInfo> }>();
const game = useGame('puzzles');
const pictures = computed(() => props.entries.flatMap((e) => (props.catalog[e.id] ? [{ ...e, info: props.catalog[e.id] }] : [])));
const at = ref(0);
watch(
	() => pictures.value.length,
	(n) => (at.value = Math.min(at.value, Math.max(0, n - 1))),
);
const shown = computed(() => pictures.value[at.value] ?? null);
const folio = (i: number) => `${i + 1} / ${pictures.value.length}`;

/**
 * The leaf being turned, over the half it starts on: forward it is the old right page turning over to show the new
 * left one; backward the old left page turning to show the new right one. Under it the new spread already lies.
 */
const leaf = ref<{ way: 'next' | 'back'; from: number; to: number } | null>(null);
const go = (i: number) => {
	if (i < 0 || i >= pictures.value.length || i === at.value) return;
	// No leaf where the pages lie one above the other (a phone), nor for those who asked for less motion.
	const still = window.matchMedia('(prefers-reduced-motion: reduce), (max-width: 640px)').matches;
	leaf.value = still ? null : { way: i > at.value ? 'next' : 'back', from: at.value, to: i };
	at.value = i;
};
const keys = (e: KeyboardEvent) => {
	if ((e.target as HTMLElement | null)?.closest('input, textarea, select')) return;
	if (e.key === 'ArrowRight') go(at.value + 1);
	else if (e.key === 'ArrowLeft') go(at.value - 1);
};
onMounted(() => window.addEventListener('keydown', keys));
onBeforeUnmount(() => window.removeEventListener('keydown', keys));

const backdrop = (info: PuzzleInfo) => (info.image ? { backgroundImage: `url("${game.fileUrl(info.image)}")` } : {});
</script>

<template>
	<p v-if="!pictures.length" class="muted">{{ game.t('Completed puzzles are mounted here, to keep.') }}</p>
	<div v-else class="album">
		<div class="book">
			<div v-if="shown" class="spread">
				<!-- While turning, the half the leaf will cover keeps the old page; the half it leaves shows the new one. -->
				<AlbumPage side="left" :entry="leaf?.way === 'next' ? pictures[leaf.from] : shown" :folio="folio(at)" />
				<AlbumPage
					side="right"
					:entry="leaf?.way === 'back' ? pictures[leaf.from] : shown"
					:folio="folio(leaf?.way === 'back' ? leaf.from : at)"
				/>
				<div v-if="leaf" :key="`${leaf.from}-${leaf.to}`" class="leaf" :class="leaf.way" @animationend="leaf = null">
					<div class="face front">
						<AlbumPage :side="leaf.way === 'next' ? 'right' : 'left'" :entry="pictures[leaf.from]" :folio="folio(leaf.from)" />
					</div>
					<div class="face back">
						<AlbumPage :side="leaf.way === 'next' ? 'left' : 'right'" :entry="pictures[leaf.to]" :folio="folio(leaf.to)" />
					</div>
				</div>
			</div>
		</div>
		<nav class="turn">
			<button type="button" class="secondary" :disabled="at === 0" @click="go(at - 1)">‹ {{ game.t('Previous page') }}</button>
			<span class="muted">{{ folio(at) }}</span>
			<button type="button" class="secondary" :disabled="at >= pictures.length - 1" @click="go(at + 1)">{{ game.t('Next page') }} ›</button>
		</nav>
		<div v-if="pictures.length > 1" class="thumbs">
			<button
				v-for="(p, i) in pictures"
				:key="p.id"
				type="button"
				class="thumb"
				:class="{ active: i === at, plain: !p.info.image }"
				:style="backdrop(p.info)"
				:title="p.info.name"
				:aria-label="p.info.name"
				@click="go(i)"
			></button>
		</div>
	</div>
</template>

<style scoped>
.album {
	display: grid;
	gap: 12px;
}

/* The album lying open: a cover's edge round two pages, a fold in the middle. */
.book {
	padding: 10px;
	border-radius: 8px;
	background: var(--frame);
	box-shadow:
		inset 0 0 0 2px color-mix(in srgb, var(--frame) 70%, #000),
		0 6px 16px color-mix(in srgb, var(--text) 20%, transparent);
	perspective: 1800px;
}

.spread {
	position: relative;
	display: grid;
	grid-template-columns: 1fr 1fr;
	min-height: 320px;
	border-radius: 3px;
	transform-style: preserve-3d;
}

/* The leaf: over the right half turning to the left (forward), or the other way, about the fold. */
.leaf {
	position: absolute;
	top: 0;
	bottom: 0;
	width: 50%;
	transform-style: preserve-3d;
	animation-duration: 0.7s;
	animation-timing-function: cubic-bezier(0.45, 0.05, 0.3, 1);
	animation-fill-mode: forwards;
	z-index: 2;
}

.leaf.next {
	left: 50%;
	transform-origin: left center;
	animation-name: turn-next;
}

.leaf.back {
	left: 0;
	transform-origin: right center;
	animation-name: turn-back;
}

.face {
	position: absolute;
	inset: 0;
	backface-visibility: hidden;
	overflow: hidden;
}

.face.back {
	transform: rotateY(180deg);
}

/* Light on the leaf as it lifts: darker towards the middle of the turn. */
.face::after {
	content: '';
	position: absolute;
	inset: 0;
	pointer-events: none;
	background: linear-gradient(to right, color-mix(in srgb, var(--text) 18%, transparent), transparent 60%);
	opacity: 0;
	animation: shade 0.7s ease forwards;
}

@keyframes turn-next {
	from {
		transform: rotateY(0deg);
	}
	to {
		transform: rotateY(-180deg);
	}
}

@keyframes turn-back {
	from {
		transform: rotateY(0deg);
	}
	to {
		transform: rotateY(180deg);
	}
}

@keyframes shade {
	50% {
		opacity: 1;
	}
	to {
		opacity: 0;
	}
}

.turn {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 12px;
}

.thumbs {
	display: flex;
	gap: 6px;
	overflow-x: auto;
	padding-bottom: 4px;
}

.thumb {
	flex: none;
	width: 44px;
	height: 44px;
	padding: 0;
	border: 2px solid var(--border);
	border-radius: 4px;
	background-size: cover;
	background-position: center;
	opacity: 0.7;
}

.thumb.plain {
	background: repeating-linear-gradient(45deg, var(--bg), var(--bg) 8px, var(--surface) 8px, var(--surface) 16px);
}

.thumb.active {
	border-color: var(--accent);
	opacity: 1;
}

/* A phone: the two pages one above the other (no leaf is turned there). */
@media (max-width: 640px) {
	.spread {
		grid-template-columns: 1fr;
	}
}

.muted {
	color: var(--muted);
}
</style>
