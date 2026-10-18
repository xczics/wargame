<script setup lang="ts">
// Places where loot drops (the owners' trees: realm > task > group, camp kind > level...), to aim puzzle pieces. A
// place is addressed by its path ("realms/black-wind/0/2"); ticking one covers everything under it.
import { ref } from 'vue';
import type { PuzzleSite } from '../../../src/shared/api';
import { useGame } from '../../core/game';

defineOptions({ name: 'SiteTree' });
const props = defineProps<{ sites: PuzzleSite[]; base?: string; selected: string[] }>();
const emit = defineEmits<{ toggle: [address: string] }>();
const game = useGame('puzzles');
const open = ref<Record<string, boolean>>({});
const address = (s: PuzzleSite) => (props.base ? `${props.base}/${s.id}` : s.id);
/** Ticked itself, or covered by a ticked place above it. */
const covered = (a: string) => props.selected.some((x) => a === x || a.startsWith(`${x}/`));
</script>

<template>
	<ul class="tree">
		<li v-for="s in sites" :key="s.id">
			<button v-if="s.children?.length" type="button" class="twist" @click="open[s.id] = !open[s.id]">
				{{ open[s.id] ? '▾' : '▸' }}
			</button>
			<span v-else class="twist"></span>
			<label>
				<input
					type="checkbox"
					:checked="covered(address(s))"
					:disabled="covered(address(s)) && !selected.includes(address(s))"
					@change="emit('toggle', address(s))"
				/>
				{{ game.t(s.label) }}
			</label>
			<SiteTree
				v-if="s.children?.length && open[s.id]"
				:sites="s.children"
				:base="address(s)"
				:selected="selected"
				@toggle="(a) => emit('toggle', a)"
			/>
		</li>
	</ul>
</template>

<style scoped>
.tree {
	list-style: none;
	margin: 0;
	padding-left: 14px;
}

.tree li > label {
	display: inline-flex;
	align-items: center;
	gap: 4px;
	margin: 0;
}

.tree input[type='checkbox'] {
	width: auto;
	margin: 0;
}

.twist {
	display: inline-block;
	width: 18px;
	padding: 0;
	background: none;
	border: none;
	color: var(--muted);
}
</style>
