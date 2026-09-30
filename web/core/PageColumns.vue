<script setup lang="ts">
// A two-column page: blocks registered for this page (or every page) in the left 1/3 and
// right 2/3 columns. Each column scrolls on its own; on narrow screens they stack. An open
// entry (e.g. a building) replaces the right column with the blocks registered on it.
import { computed, inject, nextTick, ref, watch } from 'vue';
import { EVERY_PAGE, GameKey, GameUiKey, type ColumnName } from './game';

const props = defineProps<{ page: string }>();
const ui = inject(GameUiKey)!;
const game = inject(GameKey)!;
const blocks = (column: ColumnName) => ui.blocks.filter((b) => b.column === column && (b.page === props.page || b.page === EVERY_PAGE));
const left = computed(() => blocks('left'));
const entry = computed(() => ui.entries[props.page] ?? null);
const entryBlocks = computed(() => {
	const e = entry.value;
	return e ? ui.entryBlocks.filter((b) => b.kind === e.kind && (!b.types || (e.type !== undefined && b.types.includes(e.type)))) : [];
});
const right = computed(() => (entry.value ? [] : blocks('right')));
const hasRight = computed(() => !!entry.value || right.value.length > 0);

// A newly opened entry starts at its top, and on phones (one stacked column) comes into view.
const rightEl = ref<HTMLElement>();
watch(
	() => entry.value?.id,
	async (id) => {
		await nextTick();
		if (!rightEl.value) return;
		rightEl.value.scrollTop = 0;
		if (id && matchMedia('(max-width: 743px)').matches) rightEl.value.scrollIntoView({ block: 'start' });
	},
);
const close = () => (ui.entries[props.page] = null);
</script>

<template>
	<div class="columns" :class="{ single: !left.length || !hasRight }">
		<div v-if="left.length" class="column left">
			<component :is="b.component" v-for="(b, i) in left" :key="`${b.owner}-${i}`" />
		</div>
		<div v-if="hasRight" ref="rightEl" class="column right">
			<template v-if="entry">
				<header class="entry-head">
					<button type="button" class="link" @click="close">← {{ game.t('Back') }}</button>
					<strong>{{ game.t(entry.label) }}</strong>
				</header>
				<component :is="b.component" v-for="(b, i) in entryBlocks" :key="`${entry.id}-${b.owner}-${i}`" :entry="entry" />
			</template>
			<component :is="b.component" v-for="(b, i) in right" v-else :key="`${b.owner}-${i}`" />
		</div>
	</div>
</template>

<style scoped>
.columns {
	display: grid;
	grid-template-columns: 1fr 2fr;
	height: 100%;
	min-height: 0;
}

.columns.single {
	grid-template-columns: 1fr;
}

.column {
	min-height: 0;
	overflow-y: auto;
	overscroll-behavior: contain;
	padding: 16px;
	display: flex;
	flex-direction: column;
	gap: 16px;
}

.column.left {
	border-right: 1px solid var(--border);
}

.entry-head {
	display: flex;
	align-items: baseline;
	gap: 12px;
}

/* Phone-sized screens: one column, and the whole page area scrolls instead of each column. */
@media (max-width: 743px) {
	.columns {
		display: block;
		height: auto;
	}

	.column {
		overflow: visible;
	}

	.column.left {
		border-right: none;
		padding-bottom: 0;
	}
}
</style>
