<script setup lang="ts">
// Generic widget "ui.cards": cards in sections by group (only the group chosen in the "ui.filters" of
// the same `filter`, if any), each with its status lines and buttons. Layout "tiles": small squares
// under one heading. A card with a `detail` opens it in place of the grid (text and a server form),
// with a way back. Layout "compact": a small button per card that opens it in place (e.g. item
// shortcuts on a building entry). Cards with `where` show only there ("<entry kind>:<type>", "<entry kind>#<id>"
// or "page:<id>"). On a page, a header above and the server forms of `placement` below.
import { computed, ref, watch } from 'vue';
import type { CardsData, UiCard } from '../../src/shared/ui';
import type { Entry } from '../core/game';
import { useGame } from '../core/game';
import ActionLabel from './ActionLabel.vue';
import { runAction, running } from './actions';
import Line from './Line.vue';
import { chosen } from './state';
import { hintText, uiText } from './text';

const props = defineProps<{ view: string; filter?: string; layout?: 'cards' | 'tiles' | 'compact' | 'nodes'; entry?: Entry }>();
const game = useGame('widgets');
const { Outlet } = game.use('forms');
const data = computed(() => (game.state.value?.views[props.view] ?? null) as CardsData | null);
// The chosen group, if this data has it (a choice from another settlement falls back to the default).
const only = computed(() => {
	if (!props.filter) return null;
	const pick = chosen[props.filter] ?? null;
	return pick !== null && data.value?.groups?.some((g) => g.id === pick) ? pick : (data.value?.defaultGroup ?? null);
});
const places = computed(() =>
	props.entry ? [`${props.entry.kind}:${props.entry.type}`, `${props.entry.kind}#${props.entry.id}`] : [`page:${game.currentPage.value}`],
);
const here = computed(() =>
	(data.value?.cards ?? []).filter((c) => !c.where || (Array.isArray(c.where) ? c.where : [c.where]).some((w) => places.value.includes(w))),
);
// Resync when the first countdown ends (e.g. a construction finishing).
watch(
	() =>
		Math.min(
			...[...here.value.flatMap((c) => c.lines ?? []), ...(data.value?.groups ?? []).flatMap((g) => g.lines ?? [])].flatMap((l) =>
				l.endsAt ? [l.endsAt] : [],
			),
		),
	(t) => Number.isFinite(t) && game.refreshAt(t),
	{ immediate: true },
);
// A button opening the entry this is shown on would only open it again.
const actionsOf = (c: UiCard) => (c.actions ?? []).filter((a) => !a.entry || a.entry.id !== props.entry?.id);
// Forms opened on an entry act on its settlement.
const context = computed(() => (props.entry?.data?.settlement ? { settlement: String(props.entry.data.settlement) } : {}));
const sections = computed(() => {
	const d = data.value;
	if (!d) return [];
	const cards = here.value.filter((c) => only.value === null || c.group === only.value);
	if (!d.groups?.length || props.layout === 'tiles') return [{ id: '', label: null, cards }];
	return d.groups
		.map((g) => ({ id: g.id, label: g.label, lines: g.lines, cards: cards.filter((c) => c.group === g.id) }))
		.filter((s) => s.cards.length);
});
const heading = computed(() => {
	const g = data.value?.groups?.find((x) => x.id === only.value);
	return g ? uiText(game, g.label) : uiText(game, data.value?.allTitle);
});
const opened = ref<string | null>(null);
const card = computed(() => data.value?.cards.find((c) => c.id === opened.value) ?? null);
// Gone (e.g. the last one used up) or another group chosen: back to the grid.
watch([card, only], ([c]) => {
	if (opened.value && (!c || (props.layout !== 'compact' && !c.detail))) opened.value = null;
});
watch(only, () => (opened.value = null));
const title = (c: UiCard) => `${c.icon ?? ''} ${uiText(game, c.title)}`.trim();
</script>

<template>
	<section v-if="data && layout === 'compact'" v-show="here.length" class="card compact">
		<div v-for="c in here" :key="c.id" class="item">
			<button type="button" class="small secondary" @click="opened = opened === c.id ? null : c.id">
				{{ title(c) }} <small>×{{ c.count ?? 0 }}</small>
			</button>
			<template v-if="opened === c.id">
				<small v-if="c.text" class="muted">{{ uiText(game, c.text) }}</small>
				<small v-for="(l, i) in c.detail?.lines ?? []" :key="i">{{ uiText(game, l) }}</small>
				<component
					:is="Outlet"
					v-if="c.detail?.form"
					:placement="c.detail.form.placement"
					:context="{ ...context, ...(c.detail.form.context ?? {}) }"
					:only="c.detail.form.command ? [c.detail.form.command] : undefined"
				/>
				<button
					v-for="(a, i) in c.actions ?? []"
					:key="`a${i}`"
					type="button"
					class="small"
					:disabled="!!a.blocked || running(a)"
					@click="runAction(game, a)"
				>
					<ActionLabel :action="a" />
				</button>
			</template>
		</div>
	</section>
	<section v-else-if="data && card" class="card detail">
		<div class="head">
			<h2>
				<span :class="card.rarity ? `rarity rarity-${card.rarity}` : ''">{{ title(card) }}</span>
				<small v-if="card.count && card.count > 1" class="muted"> {{ game.t('×{n}', { n: card.count }) }}</small>
			</h2>
			<button type="button" class="small secondary" @click="opened = null">{{ game.t('Back') }}</button>
		</div>
		<p v-if="card.text">{{ uiText(game, card.text) }}</p>
		<small v-for="(l, i) in card.detail?.lines ?? []" :key="i" class="muted">{{ uiText(game, l) }}</small>
		<component
			:is="Outlet"
			v-if="card.detail?.form"
			:placement="card.detail.form.placement"
			:context="{ ...context, ...(card.detail.form.context ?? {}) }"
			:only="card.detail.form.command ? [card.detail.form.command] : undefined"
		/>
		<ul v-if="card.detail?.choices" class="choices">
			<li v-for="(ch, i) in card.detail.choices" :key="i">
				<button
					type="button"
					class="small"
					:disabled="!!ch.action.blocked || running(ch.action)"
					:title="hintText(game, ch.action)"
					@click="runAction(game, ch.action)"
				>
					<ActionLabel :action="ch.action" />
				</button>
				<Line v-for="(l, k) in ch.lines ?? []" :key="k" :line="l" />
			</li>
		</ul>
	</section>
	<section v-else-if="data && (here.length || !entry)" class="card">
		<header v-if="data.header && !entry" class="header">
			<h2>{{ uiText(game, data.header.title) }}</h2>
			<div class="row">
				<Line v-for="(l, i) in data.header.lines ?? []" :key="i" :line="l" />
			</div>
		</header>
		<h2 v-if="layout === 'tiles' && heading">{{ heading }}</h2>
		<p v-if="!data.cards.length && data.empty" class="muted">{{ uiText(game, data.empty) }}</p>
		<div v-for="s in sections" :key="s.id" class="group">
			<h3 v-if="s.label">{{ uiText(game, s.label) }}</h3>
			<div v-if="'lines' in s && s.lines?.length" class="row">
				<Line v-for="(l, i) in s.lines" :key="i" :line="l" />
			</div>
			<ul v-if="layout === 'tiles'" class="tiles">
				<li v-for="c in s.cards" :key="c.id">
					<button type="button" class="tile" :title="c.text ? uiText(game, c.text) : undefined" @click="c.detail && (opened = c.id)">
						<span class="icon">{{ c.icon }}</span>
						<span class="name" :class="c.rarity ? `rarity rarity-${c.rarity}` : ''">{{ uiText(game, c.title) }}</span>
						<small v-if="c.count" class="count">×{{ c.count }}</small>
					</button>
				</li>
			</ul>
			<ul v-else-if="layout === 'nodes'" class="nodes">
				<li v-for="c in s.cards" :key="c.id" class="node">
					<div class="node-head">
						<strong :class="c.rarity ? `rarity rarity-${c.rarity}` : ''">{{ title(c) }}</strong>
						<small v-if="c.badge">{{ uiText(game, c.badge) }}</small>
					</div>
					<small v-if="c.quote" class="quote">{{ uiText(game, c.quote) }}</small>
					<small v-if="c.text" class="muted">{{ uiText(game, c.text) }}</small>
					<Line v-for="(l, i) in c.lines ?? []" :key="i" :line="l" />
					<div v-if="actionsOf(c).length" class="row">
						<button
							v-for="(a, i) in actionsOf(c)"
							:key="`a${i}`"
							type="button"
							class="small"
							:disabled="!!a.blocked || running(a)"
							:title="hintText(game, a)"
							@click="runAction(game, a)"
						>
							<ActionLabel :action="a" />
						</button>
					</div>
				</li>
			</ul>
			<ul v-else class="cards">
				<li v-for="c in s.cards" :key="c.id">
					<strong
						><span :class="c.rarity ? `rarity rarity-${c.rarity}` : ''">{{ title(c) }}</span
						><template v-if="c.count && c.count > 1"> {{ game.t('×{n}', { n: c.count }) }}</template></strong
					>
					<small v-if="c.text" class="muted">{{ uiText(game, c.text) }}</small>
					<div class="row">
						<Line v-for="(l, i) in c.lines ?? []" :key="i" :line="l" />
						<button
							v-for="(a, i) in actionsOf(c)"
							:key="`a${i}`"
							type="button"
							class="small"
							:class="{ secondary: !!a.entry }"
							:disabled="!!a.blocked || running(a)"
							:title="hintText(game, a)"
							@click="runAction(game, a)"
						>
							<ActionLabel :action="a" />
						</button>
						<button v-if="c.detail" type="button" class="small secondary" @click="opened = c.id">
							{{ c.detail.label ? uiText(game, c.detail.label) : game.t('Open') }}
						</button>
					</div>
				</li>
			</ul>
		</div>
	</section>
	<div v-if="data?.placement && !entry" class="forms">
		<component :is="Outlet" :placement="data.placement" />
	</div>
</template>

<style scoped>
.nodes {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
	gap: 10px;
}

.node {
	display: grid;
	gap: 3px;
	align-content: start;
	padding: 8px 10px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
	background: var(--surface);
}

.node-head {
	display: flex;
	justify-content: space-between;
	gap: 6px;
	align-items: baseline;
}

.node .quote {
	color: var(--muted);
	font-style: italic;
}

.node .row {
	margin-top: 4px;
}

.header {
	display: grid;
	gap: 4px;
	margin-bottom: 8px;
}

.header h2 {
	margin: 0;
}

.choices {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 8px;
}

.choices li {
	display: grid;
	gap: 2px;
	justify-items: start;
}

.forms {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
	gap: 16px;
	align-items: start;
}

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

.tiles {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
	gap: 10px;
}

.tile {
	width: 100%;
	aspect-ratio: 1;
	display: grid;
	place-items: center;
	align-content: center;
	gap: 4px;
	padding: 6px;
	background: var(--input-bg);
	color: var(--text);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	text-align: center;
	cursor: pointer;
}

.tile .icon {
	font-size: 1.8em;
}

.tile .count {
	color: var(--muted);
}

.head {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	gap: 8px;
}

.detail {
	display: grid;
	gap: 8px;
}

.detail p {
	margin: 0;
}

.compact,
.compact .item {
	display: grid;
	gap: 6px;
	justify-items: start;
}
</style>
