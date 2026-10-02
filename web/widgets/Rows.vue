<script setup lang="ts">
// Generic widget "ui.rows": lists in sections — each row an icon, a title with a badge (e.g. its
// level), status lines and buttons; rows not available yet are faded.
import { computed } from 'vue';
import type { RowsData } from '../../src/shared/ui';
import { useGame } from '../core/game';
import { runAction } from './actions';
import { uiText } from './text';

const props = defineProps<{ view: string }>();
const game = useGame();
const data = computed(() => (game.state.value?.views[props.view] ?? null) as RowsData | null);
</script>

<template>
	<section v-if="data" class="card rows">
		<h2 v-if="data.title">{{ uiText(game, data.title) }}</h2>
		<template v-for="(sec, k) in data.sections" :key="k">
			<h3 v-if="sec.title">{{ uiText(game, sec.title) }}</h3>
			<ul>
				<li v-for="r in sec.rows" :key="r.id" :class="{ locked: r.locked }">
					<div class="head">
						<strong>{{ r.icon ?? '' }} {{ uiText(game, r.title) }}</strong>
						<small v-if="r.badge">{{ uiText(game, r.badge) }}</small>
					</div>
					<small v-for="(l, i) in r.lines ?? []" :key="i" :class="l.tone === 'warn' ? 'warn' : l.tone === 'muted' ? 'muted' : ''">{{
						uiText(game, l.text)
					}}</small>
					<div v-if="r.actions?.length" class="actions">
						<button
							v-for="(a, i) in r.actions"
							:key="i"
							type="button"
							class="small"
							:disabled="!!a.blocked"
							:title="a.blocked ? uiText(game, a.blocked) : undefined"
							@click="runAction(game, a)"
						>
							{{ uiText(game, a.label) }}
						</button>
					</div>
				</li>
			</ul>
		</template>
		<small v-for="(n, i) in data.notes ?? []" :key="`n${i}`" :class="n.tone === 'warn' ? 'warn' : ''">{{ uiText(game, n.text) }}</small>
	</section>
</template>

<style scoped>
.rows ul {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 6px;
}

.rows li {
	display: grid;
	gap: 1px;
}

.rows li.locked {
	opacity: 0.6;
}

.head {
	display: flex;
	gap: 8px;
	align-items: baseline;
}

.actions {
	display: flex;
	gap: 6px;
}

h3 {
	margin: 8px 0 4px;
}

.warn {
	color: var(--danger);
}
</style>
