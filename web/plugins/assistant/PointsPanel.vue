<script setup lang="ts">
// Free points (docs/design/gameplay.md §15.4.1): rules that spend a hero's free points as they come, by stages —
// raise an attribute to a value first, then split by shares kept over every level-up — keeping some back if asked.
import { computed, ref } from 'vue';
import type { HeroInfo, SettlementSummary } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import RuleHeader from './RuleHeader.vue';
import HeroPicker from './HeroPicker.vue';
import type { PointRule, Store } from './store';
import { copyRule, newPick, uid } from './store';

const props = defineProps<{ store: Store; heroes: HeroInfo[]; cities: SettlementSummary[] }>();
const game = useGame('assistant');
const data = props.store.data;
const attributes = computed(() => game.meta.heroes?.attributes ?? []);
const newRule = (): PointRule => ({
	id: uid(),
	on: true,
	name: game.t('Points {n}', { n: data.points.rules.length + 1 }),
	heroes: { ...newPick(), states: [] },
	stages: [{ ratio: Object.fromEntries(attributes.value.slice(0, 1).map((a) => [a.id, 1])) }],
	keep: 0,
	basis: 'total',
});
const editing = ref<string | null>(null);
const add = () => {
	const r = newRule();
	data.points.rules.push(r);
	editing.value = r.id;
};
const copy = (r: PointRule) => {
	const c = copyRule(r, game.t('{0} (copy)', { 0: r.name }));
	data.points.rules.push(c);
	editing.value = c.id;
};
const attrName = (id: string) => game.t(attributes.value.find((a) => a.id === id)?.name ?? id);
const summary = (r: PointRule) =>
	r.stages
		.map((s) =>
			s.attr
				? game.t('{0} to {1}', { 0: attrName(s.attr), 1: s.target ?? 0 })
				: Object.entries(s.ratio ?? {})
						.filter(([, w]) => w > 0)
						.map(([a, w]) => game.t('{0} {1}', { 0: attrName(a), 1: w }))
						.join(' : '),
		)
		.join(' → ');
</script>

<template>
	<div class="panel">
		<div class="row">
			<h4>{{ game.t('Spending free points') }}</h4>
			<button type="button" class="small" @click="add">{{ game.t('+ A rule') }}</button>
		</div>
		<p class="muted">{{ game.t('A hero named in a rule goes by that rule; otherwise the first rule whose conditions it matches.') }}</p>
		<article v-for="(r, i) in data.points.rules" :key="r.id" class="rule">
			<RuleHeader
				:rule="r"
				:editing="editing === r.id"
				@edit="editing = editing === r.id ? null : r.id"
				@copy="copy(r)"
				@remove="data.points.rules.splice(i, 1)"
			>
				<span class="muted">{{ summary(r) }}</span>
			</RuleHeader>
			<div v-if="editing === r.id" class="form">
				<label>{{ game.t('Name') }} <input v-model="r.name" /></label>
				<HeroPicker v-model="r.heroes" :heroes="props.heroes" :cities="props.cities" />
				<div class="row wrap">
					<label>
						{{ game.t('Counted on') }}
						<select v-model="r.basis">
							<option value="total">{{ game.t('the whole attribute (equipment included)') }}</option>
							<option value="free">{{ game.t('the free points put in only') }}</option>
						</select>
					</label>
					<label>{{ game.t('Keep back') }} <input v-model.number="r.keep" type="number" min="0" /> {{ game.t('points') }}</label>
				</div>
				<ol class="stages">
					<li v-for="(s, si) in r.stages" :key="si" class="row wrap">
						<template v-if="s.attr !== undefined">
							{{ game.t('Raise') }}
							<select v-model="s.attr">
								<option v-for="a in attributes" :key="a.id" :value="a.id">{{ game.t(a.name) }}</option>
							</select>
							{{ game.t('to') }}
							<input v-model.number="s.target" type="number" min="0" />
						</template>
						<template v-else>
							{{ game.t('Then by shares:') }}
							<label v-for="a in attributes" :key="a.id" class="chip">
								{{ game.t(a.name) }}
								<input
									type="number"
									min="0"
									:value="s.ratio?.[a.id] ?? ''"
									placeholder="0"
									@input="(s.ratio ??= {})[a.id] = Number(($event.target as HTMLInputElement).value) || 0"
								/>
							</label>
						</template>
						<button type="button" class="small secondary" @click="r.stages.splice(si, 1)">✕</button>
					</li>
				</ol>
				<div class="row">
					<button type="button" class="small secondary" @click="r.stages.push({ attr: attributes[0]?.id ?? '', target: 100 })">
						{{ game.t('+ Raise one to a value') }}
					</button>
					<button type="button" class="small secondary" @click="r.stages.push({ ratio: {} })">{{ game.t('+ Split by shares') }}</button>
				</div>
				<p class="muted">
					{{
						game.t('Stages go in order: a value first, then the next; shares go on for good (later stages after them are never reached).')
					}}
				</p>
			</div>
		</article>
	</div>
</template>

<style scoped>
.panel,
.form {
	display: grid;
	gap: 8px;
}

h4 {
	margin: 0;
}

.row {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px 10px;
}

.chip {
	display: inline-flex;
	align-items: center;
	gap: 4px;
}

input[type='number'] {
	width: 5em;
}

.rule {
	display: grid;
	gap: 8px;
	padding: 8px 10px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
}

.stages {
	display: grid;
	gap: 4px;
	margin: 0;
	padding-left: 1.6em;
}

.muted {
	color: var(--muted);
}

p {
	margin: 0;
}
</style>
