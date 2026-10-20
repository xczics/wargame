<script setup lang="ts">
// The album (docs/design/gameplay.md §13.4.1): every puzzle the player completed, mounted and framed whole, to keep.
// Out-of-print ones (no longer dropping, or retired) carry a vermilion seal. What each is comes from the static catalog
// (retired ones stay in it for this), the claims and the first day from the view.
import { computed, ref } from 'vue';
import type { PuzzleAlbumEntry, PuzzleInfo } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import { formatDate } from '../../core/format';

const props = defineProps<{ entries: PuzzleAlbumEntry[]; catalog: Record<string, PuzzleInfo> }>();
const game = useGame('puzzles');
const pictures = computed(() => props.entries.flatMap((e) => (props.catalog[e.id] ? [{ ...e, info: props.catalog[e.id] }] : [])));
const open = ref<string | null>(null);
const opened = computed(() => pictures.value.find((p) => p.id === open.value) ?? null);
const url = (info: PuzzleInfo) => (info.image ? game.fileUrl(info.image) : null);
// Records from before the day was kept (user 2026-10-20: "老记录显示不出来的，可以用回退文案，要符合游戏背景").
const day = (at: number | null) =>
	at ? game.t('Completed on {date}', { date: formatDate(at) }) : game.t('The day it was completed is lost to time');
</script>

<template>
	<p v-if="!pictures.length" class="muted">{{ game.t('Completed puzzles are mounted here, to keep.') }}</p>
	<div v-else class="album">
		<button v-for="p in pictures" :key="p.id" type="button" class="mount" @click="open = p.id">
			<span class="frame">
				<span class="mat">
					<span
						class="picture"
						:class="{ plain: !p.info.image }"
						:style="url(p.info) ? { backgroundImage: `url(&quot;${url(p.info)}&quot;)` } : {}"
					></span>
				</span>
				<span v-if="p.info.outOfPrint" class="seal" :title="game.t('Out of print: it can no longer be collected')">{{
					game.t('Out of print')
				}}</span>
			</span>
			<span class="plaque">
				<strong>{{ p.info.name }}</strong>
				<span v-if="p.claims > 1" class="times">×{{ p.claims }}</span>
			</span>
			<span class="day">{{ day(p.firstAt) }}</span>
		</button>
	</div>

	<div v-if="opened" class="scrim" @click.self="open = null">
		<figure class="viewer">
			<span class="frame big">
				<span class="mat">
					<span
						class="picture"
						:class="{ plain: !opened.info.image }"
						:style="url(opened.info) ? { backgroundImage: `url(&quot;${url(opened.info)}&quot;)` } : {}"
					></span>
				</span>
				<span v-if="opened.info.outOfPrint" class="seal">{{ game.t('Out of print') }}</span>
			</span>
			<figcaption>
				<h4>
					{{ opened.info.name }} <span v-if="opened.claims > 1" class="times">×{{ opened.claims }}</span>
				</h4>
				<p class="day">{{ day(opened.firstAt) }}</p>
				<p v-if="opened.info.description" class="note">{{ opened.info.description }}</p>
				<button type="button" @click="open = null">{{ game.t('Close') }}</button>
			</figcaption>
		</figure>
	</div>
</template>

<style scoped>
.album {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
	gap: 14px;
}

.mount {
	display: grid;
	gap: 6px;
	justify-items: center;
	padding: 0;
	border: none;
	background: none;
	color: var(--text);
	cursor: pointer;
	text-align: center;
}

/* A wooden frame, a cream mat, the picture: like a scroll mounted for the wall. */
.frame {
	position: relative;
	display: block;
	width: 100%;
	padding: 7px;
	background: var(--frame);
	border-radius: 4px;
	box-shadow:
		inset 0 0 0 2px color-mix(in srgb, var(--frame) 70%, #000),
		0 4px 10px color-mix(in srgb, var(--text) 18%, transparent);
	transition: transform 0.15s ease;
}

.mount:hover .frame,
.mount:focus-visible .frame {
	transform: translateY(-2px);
}

.mat {
	display: block;
	padding: 9%;
	background: var(--mat);
	box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--frame) 35%, transparent);
}

.picture {
	display: block;
	aspect-ratio: 1;
	background-color: var(--surface);
	background-size: cover;
	background-position: center;
	box-shadow: 0 0 0 1px color-mix(in srgb, var(--text) 15%, transparent);
}

.picture.plain {
	background: repeating-linear-gradient(45deg, var(--bg), var(--bg) 8px, var(--surface) 8px, var(--surface) 16px);
}

/* A seal stamped askew on the corner, vermilion on the mat. */
.seal {
	position: absolute;
	right: 4%;
	bottom: 6%;
	padding: 3px 6px;
	border: 2px solid var(--seal);
	border-radius: 3px;
	color: var(--seal);
	font-family: 'Songti SC', 'STSong', 'Noto Serif SC', serif;
	font-weight: 700;
	font-size: 0.85rem;
	letter-spacing: 0.15em;
	line-height: 1;
	transform: rotate(-12deg);
	background: color-mix(in srgb, var(--mat) 55%, transparent);
	box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--seal) 40%, transparent);
	opacity: 0.92;
}

.frame.big .seal {
	font-size: 1.3rem;
	padding: 5px 9px;
	border-width: 3px;
}

/* The name on a small plaque under the frame. */
.plaque {
	display: inline-flex;
	gap: 6px;
	align-items: baseline;
	padding: 2px 10px;
	border: 1px solid var(--border);
	border-radius: 3px;
	background: var(--surface);
	font-family: 'Songti SC', 'STSong', 'Noto Serif SC', serif;
}

.times {
	color: var(--accent);
	font-weight: 600;
}

.day {
	color: var(--muted);
	font-size: 0.8rem;
}

.scrim {
	position: fixed;
	inset: 0;
	z-index: 50;
	display: grid;
	place-items: center;
	padding: 16px;
	background: var(--scrim);
}

.viewer {
	display: grid;
	gap: 12px;
	width: min(520px, 100%);
	max-height: 100%;
	overflow: auto;
	margin: 0;
	padding: 16px;
	border-radius: var(--radius);
	background: var(--surface);
}

.viewer h4 {
	margin: 0;
	font-family: 'Songti SC', 'STSong', 'Noto Serif SC', serif;
	font-size: 1.15rem;
}

.viewer p {
	margin: 4px 0;
}

/* The GM's words: their own line breaks kept (text, never HTML). */
.note {
	white-space: pre-line;
}

.muted {
	color: var(--muted);
}
</style>
