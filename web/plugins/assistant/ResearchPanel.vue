<script setup lang="ts">
// The research queue (docs/design/gameplay.md §15.2.1): targets ("Economics to 5"), each expanded into one-level steps
// with their prerequisites first (research-plan.ts) from the static tree and the player's levels (`research.state`,
// synced on this page). The steps are worked out again at every look, so a level reached elsewhere drops out by itself.
import { computed, ref, watch } from 'vue';
import type { ResearchState, SettlementSummary } from '../../../src/shared/api';
import type { ResearchCatalog, TechPlan } from '../../../src/shared/research';
import type { TreeData } from '../../../src/shared/ui';
import { useGame } from '../../core/game';
import { type PlanStep, planResearch, problemText, stepKey } from './research-plan';
import type { Policy, ResearchTarget, Store } from './store';
import { uid } from './store';

const props = defineProps<{ store: Store; cities: SettlementSummary[] }>();
const game = useGame('assistant');
const data = props.store.data;
const catalog = computed(() => game.static<TreeData>('research.techs')?.data as ResearchCatalog | undefined);
const state = computed(() => game.data<ResearchState>('research.state'));
const plans = computed(
	() => new Map<string, TechPlan>([...(catalog.value?.techs ?? []), ...(state.value?.own ?? [])].map((x) => [x.id, x])),
);
const levels = computed(() => state.value?.levels ?? {});
const techName = (id: string) => game.t(plans.value.get(id)?.name ?? id);
const cityName = (id: string) => game.t(props.cities.find((c) => c.id === id)?.name ?? id);
/** The techs by branch, in the tree's order. */
const branches = computed(() => {
	const out = new Map<string, TechPlan[]>();
	for (const x of plans.value.values()) out.set(x.branch ?? '', [...(out.get(x.branch ?? '') ?? []), x]);
	return [...out].map(([id, techs]) => ({ id, label: id ? game.t(id) : game.t('Other techs'), techs }));
});

/* ----- a new target ----- */
const tech = ref('');
const level = ref(1);
const where = ref('');
const policy = ref<Policy>('skip');
const maxOf = (id: string) => plans.value.get(id)?.maxLevel ?? 1;
watch(tech, (id) => (level.value = Math.min(maxOf(id), (levels.value[id] ?? 0) + 1)));
const preview = computed(() => {
	if (!tech.value) return null;
	const plan = planResearch([...data.research.targets, { id: '', tech: tech.value, level: level.value }], plans.value, levels.value);
	return { steps: plan.steps.filter((s) => s.target === ''), problem: plan.problems[''] };
});
function add() {
	if (!tech.value || preview.value?.problem) return;
	data.research.targets.push({ id: uid(), tech: tech.value, level: level.value, settlement: where.value, onFail: policy.value });
}

/* ----- the queue ----- */
const plan = computed(() => planResearch(data.research.targets, plans.value, levels.value));
const stepsOf = (id: string) => plan.value.steps.filter((s) => s.target === id);
const stepText = (s: PlanStep) => `${techName(s.tech)} ${game.t('Lv {n}', { n: s.level })}`;
const stepsLine = (steps: PlanStep[]) => steps.map(stepText).join(' → ');
const problemOf = (target: ResearchTarget) => {
	const p = plan.value.problems[target.id];
	return p ? problemText(p, techName, (text, vars) => game.t(text, vars)) : null;
};
const move = (i: number, to: number) => {
	const list = data.research.targets;
	if (to < 0 || to >= list.length) return;
	const [x] = list.splice(i, 1);
	list.splice(to, 0, x);
};
</script>

<template>
	<div class="panel">
		<section>
			<h4>{{ game.t('Add a research target') }}</h4>
			<div class="row wrap">
				<select v-model="tech">
					<option value="">{{ game.t('Tech…') }}</option>
					<optgroup v-for="b in branches" :key="b.id" :label="b.label">
						<option v-for="x in b.techs" :key="x.id" :value="x.id">
							{{ game.t(x.name) }} ({{ game.t('Lv {n}/{max}', { n: levels[x.id] ?? 0, max: x.maxLevel }) }})
						</option>
					</optgroup>
				</select>
				<label v-if="tech">
					{{ game.t('up to level') }}
					<input v-model.number="level" type="number" min="1" :max="maxOf(tech)" />
				</label>
				<select v-model="where">
					<option value="">{{ game.t('In any settlement with an institute free') }}</option>
					<option v-for="c in props.cities" :key="c.id" :value="c.id">{{ game.t('Only in {0}', { 0: game.t(c.name) }) }}</option>
				</select>
				<button type="button" :disabled="!tech || !!preview?.problem || !preview?.steps.length" @click="add">{{ game.t('Add') }}</button>
			</div>
			<p v-if="preview?.problem" class="warn">{{ problemText(preview.problem, techName, (text, vars) => game.t(text, vars)) }}</p>
			<p v-else-if="preview && !preview.steps.length" class="muted">
				{{ game.t('Nothing to do: reached already, or queued by a target above.') }}
			</p>
			<p v-else-if="preview" class="muted">{{ game.t('{n} steps: {0}', { n: preview.steps.length, 0: stepsLine(preview.steps) }) }}</p>
		</section>
		<section>
			<div class="row">
				<h4>{{ game.t('Research targets') }} ({{ data.research.targets.length }})</h4>
				<label class="chip">
					{{ game.t('New targets, when they cannot go ahead:') }}
					<select v-model="policy">
						<option value="skip">{{ game.t('policy:skip') }}</option>
						<option value="cancel">{{ game.t('policy:cancel') }}</option>
						<option value="block">{{ game.t('policy:block') }}</option>
					</select>
				</label>
			</div>
			<p class="muted">
				{{
					game.t(
						'Prerequisites come first, a level a step; one shared by several targets is done once. Waiting for resources (after what is kept back on the Building tab), an institute or the step before is not a failure.',
					)
				}}
			</p>
			<ol class="queue">
				<li v-for="(x, i) in data.research.targets" :key="x.id">
					<div class="line">
						<span class="what">
							{{ techName(x.tech) }} {{ game.t('Lv {n}', { n: x.level }) }}
							<span class="muted">· {{ x.settlement ? cityName(x.settlement) : game.t('any settlement') }}</span>
						</span>
						<span v-if="x.note" class="muted note">{{ x.note }}</span>
						<span class="tools">
							<select v-model="x.onFail" :title="game.t('When it cannot go ahead')">
								<option value="skip">{{ game.t('policy:skip') }}</option>
								<option value="cancel">{{ game.t('policy:cancel') }}</option>
								<option value="block">{{ game.t('policy:block') }}</option>
							</select>
							<button type="button" class="small secondary" :title="game.t('To the top')" @click="move(i, 0)">⤒</button>
							<button type="button" class="small secondary" @click="move(i, i - 1)">↑</button>
							<button type="button" class="small secondary" @click="move(i, i + 1)">↓</button>
							<button type="button" class="small secondary" @click="data.research.targets.splice(i, 1)">✕</button>
						</span>
					</div>
					<p v-if="problemOf(x)" class="warn">{{ problemOf(x) }}</p>
					<ul v-else class="steps">
						<li v-for="s in stepsOf(x.id)" :key="stepKey(s)">
							{{ stepText(s) }}
							<span v-if="x.notes?.[stepKey(s)]" class="muted note">· {{ x.notes[stepKey(s)] }}</span>
						</li>
						<li v-if="!stepsOf(x.id).length" class="muted">{{ game.t('Its steps are under the targets above.') }}</li>
					</ul>
				</li>
			</ol>
			<button v-if="data.research.targets.length" type="button" class="small secondary" @click="data.research.targets.splice(0)">
				{{ game.t('Clear the queue') }}
			</button>
		</section>
	</div>
</template>

<style scoped>
.panel {
	display: grid;
	gap: 14px;
}

section {
	display: grid;
	gap: 6px;
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

.queue {
	display: grid;
	gap: 4px;
	margin: 0;
	padding-left: 1.6em;
	max-height: 520px;
	overflow: auto;
}

.queue > li {
	padding: 3px 0;
	border-bottom: 1px solid var(--border);
}

.line {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 10px;
}

.tools {
	display: inline-flex;
	gap: 4px;
	margin-left: auto;
}

.steps {
	margin: 2px 0 0;
	padding-left: 1.2em;
	font-size: 0.9rem;
}

.note {
	font-size: 0.85rem;
}

.muted {
	color: var(--muted);
}

.warn {
	color: var(--danger);
}

p {
	margin: 0;
}
</style>
