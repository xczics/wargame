<script setup lang="ts">
// One cell of `ui.cells` (or of a row of cells in `ui.rows`): label, small text, note, look; it runs
// its action, or (selectable) tells the parent it was picked.
import type { UiCellItem } from '../../src/shared/ui';
import { useGame } from '../core/game';
import { runAction } from './actions';
import { uiText } from './text';

const props = defineProps<{ cell: UiCellItem | null; active?: boolean }>();
const emit = defineEmits<{ pick: [id: string] }>();
const game = useGame();
function click() {
	const c = props.cell;
	if (!c) return;
	if (c.action) {
		if (c.action.blocked) return game.toast(uiText(game, c.action.blocked));
		return runAction(game, c.action);
	}
	if (c.selectable) emit('pick', c.id);
}
</script>

<template>
	<button
		type="button"
		class="cell"
		:class="[cell?.tone, { active }]"
		:disabled="!cell || (!cell.selectable && !cell.action)"
		:title="cell?.title ? uiText(game, cell.title) : undefined"
		@click="click"
	>
		<template v-if="cell">
			<strong v-if="cell.label" :class="cell.rarity ? `rarity rarity-${cell.rarity}` : ''">{{ uiText(game, cell.label) }}</strong>
			<small v-if="cell.sub">{{ uiText(game, cell.sub) }}</small>
			<small v-if="cell.note" class="note">{{ uiText(game, cell.note) }}</small>
		</template>
	</button>
</template>

<style scoped>
.cell {
	aspect-ratio: 1;
	min-width: 0;
	padding: 2px;
	display: grid;
	place-content: center;
	gap: 2px;
	background: var(--input-bg);
	color: var(--muted);
	border: 1px dashed var(--border);
	border-radius: var(--radius);
}

.cell.solid {
	color: var(--text);
	border-style: solid;
}

.cell.strong {
	color: var(--text);
	border: 2px solid var(--info);
}

.cell.add {
	color: var(--accent);
	border-color: var(--accent);
}

.note {
	color: var(--muted);
	font-size: 0.75em;
}

.cell.active {
	border-color: var(--accent);
	box-shadow: inset 0 0 0 2px var(--accent);
}
</style>
