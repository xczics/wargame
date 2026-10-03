<script setup lang="ts">
// One status line of a generic widget: its tone, and a live countdown when it has `endsAt` (with a
// progress bar when it also has `startedAt`).
import type { UiLine } from '../../src/shared/ui';
import { useGame } from '../core/game';
import { hintText, uiText } from './text';
import { left } from './time';

defineProps<{ line: UiLine }>();
const game = useGame('widgets');
const progress = (startedAt: number, endsAt: number) =>
	Math.min(100, Math.max(0, ((game.serverNow() - startedAt) / (endsAt - startedAt)) * 100));
</script>

<template>
	<small
		:class="[line.tone, line.rarity ? `rarity rarity-${line.rarity}` : '', { hinted: line.hint?.length }]"
		:title="hintText(game, line)"
		>{{ uiText(game, line.text)
		}}<template v-for="(p, i) in line.parts ?? []" :key="i"
			>{{ i ? game.t(', ') : ' ' }}<span :class="p.rarity ? `rarity rarity-${p.rarity}` : ''">{{ uiText(game, p.text) }}</span></template
		><template v-if="line.endsAt"> · {{ left(game, line.endsAt) }}</template></small
	>
	<div v-if="line.endsAt && line.startedAt" class="bar">
		<div :style="{ width: `${progress(line.startedAt, line.endsAt)}%` }"></div>
	</div>
</template>

<style scoped>
.hinted {
	text-decoration: underline dotted;
	text-underline-offset: 3px;
	cursor: help;
}

.muted {
	color: var(--muted);
}

.warn {
	color: var(--danger);
}

.info {
	color: var(--info);
}

.bar {
	width: 100%;
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
</style>
