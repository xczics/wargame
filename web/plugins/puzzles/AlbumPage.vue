<script setup lang="ts">
// One page of the album (Album.vue): `left` the photograph held by paper corners, `right` its name, day and the GM's
// words. Drawn both where it lies and on the leaf being turned.
import { computed } from 'vue';
import type { PuzzleAlbumEntry, PuzzleInfo } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import { formatDate } from '../../core/format';

const props = defineProps<{ side: 'left' | 'right'; entry: PuzzleAlbumEntry & { info: PuzzleInfo }; folio: string }>();
const game = useGame('puzzles');
const url = computed(() => (props.entry.info.image ? game.fileUrl(props.entry.info.image) : null));
// Records from before the day was kept (user 2026-10-20: "老记录显示不出来的，可以用回退文案，要符合游戏背景").
const day = computed(() =>
	props.entry.firstAt
		? game.t('Completed on {date}', { date: formatDate(props.entry.firstAt) })
		: game.t('The day it was completed is lost to time'),
);
</script>

<template>
	<div v-if="side === 'left'" class="page left">
		<span class="mount">
			<span class="picture" :class="{ plain: !url }" :style="url ? { backgroundImage: `url(&quot;${url}&quot;)` } : {}"></span>
			<span class="corner tl"></span><span class="corner tr"></span><span class="corner bl"></span><span class="corner br"></span>
		</span>
	</div>
	<div v-else class="page right">
		<h4>{{ entry.info.name }}</h4>
		<p class="day">{{ day }}</p>
		<p v-if="entry.claims > 1" class="times">{{ game.t('Completed {n} times', { n: entry.claims }) }}</p>
		<p v-if="entry.info.description" class="note">{{ entry.info.description }}</p>
		<span v-if="entry.info.outOfPrint" class="seal" :title="game.t('Out of print: it can no longer be collected')">
			{{ game.t('Out of print') }}
		</span>
		<span class="folio">{{ folio }}</span>
	</div>
</template>

<style scoped>
.page {
	position: relative;
	height: 100%;
	box-sizing: border-box;
	padding: 22px;
	background-color: var(--mat);
}

/* The fold: shade falling to the middle from both pages. */
.page.left {
	display: grid;
	place-items: center;
	background-image: linear-gradient(to left, color-mix(in srgb, var(--text) 14%, transparent), transparent 12%);
}

.page.right {
	display: flex;
	flex-direction: column;
	gap: 8px;
	background-image: linear-gradient(to right, color-mix(in srgb, var(--text) 14%, transparent), transparent 12%);
}

/* The photograph held by four paper corners. */
.mount {
	position: relative;
	display: block;
	width: min(100%, 360px);
	padding: 6px;
	background: var(--surface);
	box-shadow: 0 3px 8px color-mix(in srgb, var(--text) 22%, transparent);
	transform: rotate(-1deg);
}

.picture {
	display: block;
	aspect-ratio: 1;
	background-color: var(--bg);
	background-size: cover;
	background-position: center;
}

.picture.plain {
	background: repeating-linear-gradient(45deg, var(--bg), var(--bg) 8px, var(--surface) 8px, var(--surface) 16px);
}

.corner {
	position: absolute;
	width: 22px;
	height: 22px;
	background: color-mix(in srgb, var(--frame) 80%, var(--mat));
}

.corner.tl {
	top: -4px;
	left: -4px;
	clip-path: polygon(0 0, 100% 0, 0 100%);
}

.corner.tr {
	top: -4px;
	right: -4px;
	clip-path: polygon(0 0, 100% 0, 100% 100%);
}

.corner.bl {
	bottom: -4px;
	left: -4px;
	clip-path: polygon(0 0, 100% 100%, 0 100%);
}

.corner.br {
	bottom: -4px;
	right: -4px;
	clip-path: polygon(100% 0, 100% 100%, 0 100%);
}

h4 {
	margin: 8px 0 0;
	font-family: 'Songti SC', 'STSong', 'Noto Serif SC', serif;
	font-size: 1.5rem;
	letter-spacing: 0.08em;
	color: var(--text);
}

p {
	margin: 0;
}

.day {
	color: var(--muted);
	font-size: 0.9rem;
}

.times {
	color: var(--accent);
	font-weight: 600;
}

/* The GM's words: their own line breaks kept (text, never HTML). */
.note {
	margin-top: 10px;
	white-space: pre-line;
	line-height: 1.8;
	font-family: 'Kaiti SC', 'STKaiti', 'KaiTi', 'Songti SC', serif;
	font-size: 1.05rem;
	color: var(--text);
}

/* A seal stamped on the page, askew, vermilion. */
.seal {
	position: absolute;
	right: 24px;
	bottom: 44px;
	padding: 6px 10px;
	border: 3px solid var(--seal);
	border-radius: 4px;
	color: var(--seal);
	font-family: 'Songti SC', 'STSong', 'Noto Serif SC', serif;
	font-weight: 700;
	font-size: 1.4rem;
	letter-spacing: 0.2em;
	line-height: 1;
	transform: rotate(-14deg);
	box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--seal) 40%, transparent);
	opacity: 0.88;
}

.folio {
	position: absolute;
	right: 22px;
	bottom: 14px;
	color: var(--muted);
	font-size: 0.8rem;
}

@media (max-width: 640px) {
	.page.left,
	.page.right {
		background-image: none;
	}

	.page.right {
		padding-bottom: 48px;
		min-height: 160px;
	}
}
</style>
