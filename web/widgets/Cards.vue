<script setup lang="ts">
// Generic widget "ui.cards": cards in sections by group (only the group chosen in the "ui.filters" of
// the same \`filter\`, if any), each with its status lines and buttons.
import { computed } from 'vue';
import type { CardsData, UiCard } from '../../src/shared/ui';
import { useGame } from '../core/game';
import { runAction } from './actions';
import { chosen } from './state';
import { uiText } from './text';

const props = defineProps<{ view: string; filter?: string }>();
const game = useGame();
const data = computed(() => (game.state.value?.views[props.view] ?? null) as CardsData | null);
const sections = computed(() => {
	const d = data.value;
	if (!d) return [];
	const only = props.filter ? (chosen[props.filter] ?? null) : null;
	const cards = d.cards.filter((c) => only === null || c.group === only);
	if (!d.groups?.length) return [{ id: '', label: null, cards }];
	return d.groups.map((g) => ({ id: g.id, label: g.label, cards: cards.filter((c) => c.group === g.id) })).filter((s) => s.cards.length);
});
const title = (c: UiCard) => `${c.icon ?? ''} ${uiText(game, c.title)}`.trim();
</script>

<template>
	<section v-if="data" class="card">
		<p v-if="!data.cards.length && data.empty" class="muted">{{ uiText(game, data.empty) }}</p>
		<div v-for="s in sections" :key="s.id" class="group">
			<h3 v-if="s.label">{{ uiText(game, s.label) }}</h3>
			<ul class="cards">
				<li v-for="c in s.cards" :key="c.id">
					<strong
						><span :class="c.rarity ? `rarity rarity-${c.rarity}` : ''">{{ title(c) }}</span
						><template v-if="c.count && c.count > 1"> {{ game.t('×{n}', { n: c.count }) }}</template></strong
					>
					<small v-if="c.text" class="muted">{{ uiText(game, c.text) }}</small>
					<div class="row">
						<small v-for="(l, i) in c.lines ?? []" :key="i" :class="l.tone === 'warn' ? 'warn' : l.tone === 'muted' ? 'muted' : ''">{{
							uiText(game, l.text)
						}}</small>
						<button
							v-for="(a, i) in c.actions ?? []"
							:key="`a${i}`"
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
		</div>
	</section>
</template>

<style scoped>
.group h3 {
	margin: 14px 0 6px;
}

.cards {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
	gap: 10px;
}

.cards li {
	display: grid;
	gap: 4px;
	padding: 10px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
	align-content: space-between;
}

.row {
	display: flex;
	gap: 8px;
	align-items: center;
	flex-wrap: wrap;
}

.warn {
	color: var(--danger);
}
</style>
