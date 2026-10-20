<script setup lang="ts">
// Adventures (docs/design/gameplay.md §15.3): a queue of runs (the next one when the hero is back), and levelling rules
// that pick, for each hero, the task giving the most experience among those it clears safely enough (the same margins
// as the Realms page: src/shared/realms.ts). Repeats within a run stay the realms' own "run again" (travel packs).
import { computed, ref } from 'vue';
import type { HeroInfo, RealmsOverview, SettlementSummary } from '../../../src/shared/api';
import { nameKey } from '../../../src/shared/heroes';
import { useGame } from '../../core/game';
import HeroPicker from './HeroPicker.vue';
import type { LevelRule, Policy, Store } from './store';
import { newPick, uid } from './store';

const props = defineProps<{ store: Store; heroes: HeroInfo[]; cities: SettlementSummary[]; realms: RealmsOverview | null }>();
const game = useGame('assistant');
const data = props.store.data;
const name = (h: HeroInfo) => game.t(nameKey(h));
const heroName = (id: string) => {
	const h = props.heroes.find((x) => x.id === id);
	return h ? name(h) : '?';
};
const open = computed(() => (props.realms?.realms ?? []).filter((r) => r.unlocked));
const taskName = (realm: string, task: number) => {
	const r = props.realms?.realms.find((x) => x.id === realm);
	return r ? `${game.t(r.name)} · ${game.t(r.tasks[task]?.name ?? '')}` : realm;
};

const hero = ref('');
const realm = ref('');
const task = ref(0);
const repeat = ref(0);
const times = ref(1);
const policy = ref<Policy>('skip');
const addRuns = () => {
	if (!hero.value || !realm.value) return;
	for (let i = 0; i < Math.max(1, times.value); i++)
		data.realms.queue.push({
			id: uid(),
			hero: hero.value,
			realm: realm.value,
			task: task.value,
			repeat: repeat.value,
			onFail: policy.value,
		});
};
const move = (i: number, to: number) => {
	const list = data.realms.queue;
	if (to < 0 || to >= list.length) return;
	const [x] = list.splice(i, 1);
	list.splice(to, 0, x);
};

const newRule = (): LevelRule => ({
	id: uid(),
	on: true,
	name: game.t('Levelling {n}', { n: data.realms.leveling.length + 1 }),
	heroes: newPick(),
	tier: 'easy',
	by: 'perHour',
	realms: [],
	exclude: [],
	clearedOnly: false,
	repeat: 0,
	onInjury: 'wait',
	noTask: 'wait',
	leaveDuty: false,
});
const editing = ref<string | null>(null);
const add = () => {
	const r = newRule();
	data.realms.leveling.push(r);
	editing.value = r.id;
};
const copy = (r: LevelRule) => {
	const c: LevelRule = { ...JSON.parse(JSON.stringify(r)), id: uid(), name: `${r.name} ${game.t('(copy)')}`, stopped: undefined };
	data.realms.leveling.push(c);
	editing.value = c.id;
};
const toggle = (list: string[], id: string) => {
	const i = list.indexOf(id);
	if (i >= 0) list.splice(i, 1);
	else list.push(id);
};
const dateInput = (ms?: number) => (ms ? new Date(ms - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');
const fromDate = (v: string) => (v ? new Date(v).getTime() : undefined);
</script>

<template>
	<div class="panel">
		<p v-if="!props.realms" class="muted">{{ game.t('Loading…') }}</p>
		<section>
			<h4>{{ game.t('Adventure queue') }}</h4>
			<p class="muted">{{ game.t('Runs in order: the next one sets out when its hero is back and well.') }}</p>
			<div class="row wrap">
				<select v-model="hero">
					<option value="">{{ game.t('Hero…') }}</option>
					<option v-for="h in props.heroes" :key="h.id" :value="h.id">{{ name(h) }} · {{ game.t('Lv {n}', { n: h.level }) }}</option>
				</select>
				<select v-model="realm">
					<option value="">{{ game.t('Realm…') }}</option>
					<option v-for="r in open" :key="r.id" :value="r.id">{{ game.t(r.name) }}</option>
				</select>
				<select v-if="realm" v-model.number="task">
					<option v-for="(t, i) in open.find((r) => r.id === realm)?.tasks ?? []" :key="i" :value="i">
						{{ i + 1 }}. {{ game.t(t.name) }}
					</option>
				</select>
				<label>{{ game.t('runs again each time') }} <input v-model.number="repeat" type="number" min="0" /></label>
				<label>× <input v-model.number="times" type="number" min="1" /></label>
				<select v-model="policy" :title="game.t('When it cannot go ahead')">
					<option value="skip">{{ game.t('policy:skip') }}</option>
					<option value="cancel">{{ game.t('policy:cancel') }}</option>
					<option value="block">{{ game.t('policy:block') }}</option>
				</select>
				<button type="button" :disabled="!hero || !realm" @click="addRuns">{{ game.t('Add') }}</button>
			</div>
			<ol class="queue">
				<li v-for="(q, i) in data.realms.queue" :key="q.id">
					<span
						>{{ heroName(q.hero) }} → {{ taskName(q.realm, q.task) }}<template v-if="q.repeat"> (+{{ q.repeat }})</template></span
					>
					<span v-if="q.note" class="muted note">{{ q.note }}</span>
					<span class="tools">
						<select v-model="q.onFail">
							<option value="skip">{{ game.t('policy:skip') }}</option>
							<option value="cancel">{{ game.t('policy:cancel') }}</option>
							<option value="block">{{ game.t('policy:block') }}</option>
						</select>
						<button type="button" class="small secondary" @click="move(i, i - 1)">↑</button>
						<button type="button" class="small secondary" @click="move(i, i + 1)">↓</button>
						<button type="button" class="small secondary" @click="data.realms.queue.splice(i, 1)">✕</button>
					</span>
				</li>
			</ol>
		</section>
		<section>
			<div class="row">
				<h4>{{ game.t('Levelling') }}</h4>
				<button type="button" class="small" @click="add">{{ game.t('+ A rule') }}</button>
			</div>
			<p class="muted">
				{{
					game.t(
						'Each hero of a rule takes the task with the most experience among those it clears safely enough; heroes in the queue above follow the queue.',
					)
				}}
			</p>
			<article v-for="(r, i) in data.realms.leveling" :key="r.id" class="rule">
				<header class="row">
					<label class="chip"
						><input v-model="r.on" type="checkbox" @change="r.stopped = undefined" /> <strong>{{ r.name }}</strong></label
					>
					<span v-if="r.stopped" class="muted">{{ game.t('Stopped: {0}', { 0: r.stopped }) }}</span>
					<span class="tools">
						<button type="button" class="small secondary" @click="editing = editing === r.id ? null : r.id">
							{{ game.t(editing === r.id ? 'Done' : 'Edit') }}
						</button>
						<button type="button" class="small secondary" @click="copy(r)">{{ game.t('Copy') }}</button>
						<button type="button" class="small secondary" @click="data.realms.leveling.splice(i, 1)">✕</button>
					</span>
				</header>
				<div v-if="editing === r.id" class="form">
					<label>{{ game.t('Name') }} <input v-model="r.name" /></label>
					<HeroPicker v-model="r.heroes" :heroes="props.heroes" :cities="props.cities" />
					<div class="row wrap">
						<label>
							{{ game.t('Only tasks at least') }}
							<select v-model="r.tier">
								<option value="easy">{{ game.t('outlook:easy') }}</option>
								<option value="even">{{ game.t('outlook:even') }}</option>
							</select>
						</label>
						<label>
							{{ game.t('Most experience') }}
							<select v-model="r.by">
								<option value="perHour">{{ game.t('an hour') }}</option>
								<option value="perRun">{{ game.t('a run') }}</option>
							</select>
						</label>
						<label class="chip"><input v-model="r.clearedOnly" type="checkbox" /> {{ game.t('Only tasks cleared before') }}</label>
						<label>{{ game.t('runs again each time') }} <input v-model.number="r.repeat" type="number" min="0" /></label>
					</div>
					<div class="row wrap">
						<span class="muted">{{ game.t('Realms (none ticked: all open ones)') }}</span>
						<label v-for="x in open" :key="x.id" class="chip">
							<input type="checkbox" :checked="r.realms.includes(x.id)" @change="toggle(r.realms, x.id)" /> {{ game.t(x.name) }}
						</label>
					</div>
					<details>
						<summary>{{ game.t('Tasks left out') }} ({{ r.exclude.length }})</summary>
						<div v-for="x in open" :key="x.id" class="row wrap">
							<span class="muted">{{ game.t(x.name) }}</span>
							<label v-for="(t, ti) in x.tasks" :key="ti" class="chip">
								<input type="checkbox" :checked="r.exclude.includes(`${x.id}/${ti}`)" @change="toggle(r.exclude, `${x.id}/${ti}`)" />
								{{ game.t(t.name) }}
							</label>
						</div>
					</details>
					<div class="row wrap">
						<label>
							{{ game.t('Stop a hero at level') }}
							<input
								type="number"
								min="1"
								:value="r.stopAtLevel ?? ''"
								@input="r.stopAtLevel = Number(($event.target as HTMLInputElement).value) || undefined"
							/>
						</label>
						<label>
							{{ game.t('Stop at') }}
							<input
								type="datetime-local"
								:value="dateInput(r.stopAt)"
								@input="r.stopAt = fromDate(($event.target as HTMLInputElement).value)"
							/>
						</label>
						<label>
							{{ game.t('Injured') }}
							<select v-model="r.onInjury">
								<option value="wait">{{ game.t('go on once healed') }}</option>
								<option value="stop">{{ game.t('stop that hero') }}</option>
							</select>
						</label>
						<label>
							{{ game.t('No task safe enough') }}
							<select v-model="r.noTask">
								<option value="wait">{{ game.t('wait') }}</option>
								<option value="stop">{{ game.t('stop that hero') }}</option>
							</select>
						</label>
						<label class="chip"
							><input v-model="r.leaveDuty" type="checkbox" /> {{ game.t('Take heroes out of office to level them') }}</label
						>
					</div>
				</div>
			</article>
		</section>
	</div>
</template>

<style scoped>
.panel,
section,
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

.queue {
	display: grid;
	gap: 4px;
	margin: 0;
	padding-left: 1.6em;
}

.queue li {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 10px;
	border-bottom: 1px solid var(--border);
}

.tools {
	display: inline-flex;
	gap: 4px;
	margin-left: auto;
}

.note {
	font-size: 0.85rem;
}

.muted {
	color: var(--muted);
}

p {
	margin: 0;
}

summary {
	cursor: pointer;
}
</style>
