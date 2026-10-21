<script setup lang="ts">
// Raiding camps (docs/design/gameplay.md §15.4): rules of where from, which camps (named, or by kind, level and
// distance), how many troops (the player's numbers, or the camp's garrison x a factor), how the five lanes are filled,
// a hero to lead, and when to stop. A party of a rule goes again from a settlement once the last one is home.
import { computed, ref } from 'vue';
import type { HeroInfo, SettlementSummary } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import HeroPicker from './HeroPicker.vue';
import type { CampRule, Store } from './store';
import { newPick, uid } from './store';

const props = defineProps<{ store: Store; heroes: HeroInfo[]; cities: SettlementSummary[] }>();
const game = useGame('assistant');
const data = props.store.data;
const npcKinds = computed(() => (game.meta.settlementKinds ?? []).filter((k) => k.npc));
const myKinds = computed(() => (game.meta.settlementKinds ?? []).filter((k) => !k.npc && props.cities.some((c) => c.kind === k.id)));
const units = computed(() => (game.meta.units ?? []).filter((u) => u.family));
const newRule = (): CampRule => ({
	id: uid(),
	on: true,
	name: game.t('Raids {n}', { n: data.camps.rules.length + 1 }),
	from: { ids: props.cities[0] ? [props.cities[0].id] : [], all: false, kinds: [] },
	targets: [],
	kinds: [],
	distance: 20,
	pick: 'nearest',
	force: 'factor',
	fixed: {},
	factor: 1.5,
	formation: 'five',
	shuffle: true,
	hero: null,
	heroMissing: 'without',
	stopNoTarget: false,
	onFail: 'skip',
	sent: 0,
	lost: 0,
	streak: 0,
	marches: [],
});
const editing = ref<string | null>(null);
const add = () => {
	const r = newRule();
	data.camps.rules.push(r);
	editing.value = r.id;
};
const copy = (r: CampRule) => {
	const c: CampRule = {
		...JSON.parse(JSON.stringify(r)),
		id: uid(),
		name: `${r.name} ${game.t('(copy)')}`,
		sent: 0,
		lost: 0,
		streak: 0,
		marches: [],
		stopped: undefined,
	};
	data.camps.rules.push(c);
	editing.value = c.id;
};
const reset = (r: CampRule) => Object.assign(r, { sent: 0, lost: 0, streak: 0, stopped: undefined });
const toggle = (list: string[], id: string) => {
	const i = list.indexOf(id);
	if (i >= 0) list.splice(i, 1);
	else list.push(id);
};
const num = (v: string) => (v === '' ? undefined : Number(v));
const dateInput = (ms?: number) => (ms ? new Date(ms - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');
const fromDate = (v: string) => (v ? new Date(v).getTime() : undefined);
</script>

<template>
	<div class="panel">
		<div class="row">
			<h4>{{ game.t('Raiding camps') }}</h4>
			<button type="button" class="small" @click="add">{{ game.t('+ A rule') }}</button>
		</div>
		<p class="muted">{{ game.t('A rule sends a party from each of its settlements; the next leaves once it is home.') }}</p>
		<article v-for="(r, i) in data.camps.rules" :key="r.id" class="rule">
			<header class="row">
				<label class="chip"
					><input v-model="r.on" type="checkbox" @change="r.stopped = undefined" /> <strong>{{ r.name }}</strong></label
				>
				<span class="muted">{{ game.t('Sent {0} · lost {1} units · defeats in a row {2}', { 0: r.sent, 1: r.lost, 2: r.streak }) }}</span>
				<span v-if="r.stopped" class="muted">{{ game.t('Stopped: {0}', { 0: r.stopped }) }}</span>
				<span class="tools">
					<button type="button" class="small secondary" @click="editing = editing === r.id ? null : r.id">
						{{ game.t(editing === r.id ? 'Done' : 'Edit') }}
					</button>
					<button type="button" class="small secondary" @click="copy(r)">{{ game.t('Copy') }}</button>
					<button type="button" class="small secondary" @click="reset(r)">{{ game.t('Reset counts') }}</button>
					<button type="button" class="small secondary" @click="data.camps.rules.splice(i, 1)">✕</button>
				</span>
			</header>
			<div v-if="editing === r.id" class="form">
				<label>{{ game.t('Name') }} <input v-model="r.name" /></label>
				<fieldset>
					<legend>{{ game.t('From') }}</legend>
					<label class="chip"><input v-model="r.from.all" type="checkbox" /> {{ game.t('Every settlement') }}</label>
					<label v-for="k in myKinds" :key="k.id" class="chip">
						<input type="checkbox" :checked="r.from.kinds.includes(k.id)" @change="toggle(r.from.kinds, k.id)" />
						{{ game.t('every {0}', { 0: game.t(k.name) }) }}
					</label>
					<label v-for="c in props.cities" :key="c.id" class="chip">
						<input type="checkbox" :checked="r.from.ids.includes(c.id)" @change="toggle(r.from.ids, c.id)" /> {{ game.t(c.name) }}
					</label>
				</fieldset>
				<fieldset>
					<legend>{{ game.t('Camps') }}</legend>
					<label v-for="k in npcKinds" :key="k.id" class="chip">
						<input type="checkbox" :checked="r.kinds.includes(k.id)" @change="toggle(r.kinds, k.id)" /> {{ game.t(k.name) }}
					</label>
					<span class="muted">{{ game.t('(none ticked: any kind)') }}</span>
					<label>
						{{ game.t('Level') }}
						<input type="number" min="1" :value="r.levelMin ?? ''" @input="r.levelMin = num(($event.target as HTMLInputElement).value)" />
						–
						<input type="number" min="1" :value="r.levelMax ?? ''" @input="r.levelMax = num(($event.target as HTMLInputElement).value)" />
					</label>
					<label>{{ game.t('Within (tiles)') }} <input v-model.number="r.distance" type="number" min="1" /></label>
					<label>
						{{ game.t('Pick') }}
						<select v-model="r.pick">
							<option value="nearest">{{ game.t('the nearest') }}</option>
							<option value="highest">{{ game.t('the highest level') }}</option>
							<option value="random">{{ game.t('at random') }}</option>
						</select>
					</label>
				</fieldset>
				<fieldset>
					<legend>{{ game.t('Troops') }}</legend>
					<label class="chip"><input v-model="r.force" type="radio" value="factor" /> {{ game.t("The camp's garrison ×") }}</label>
					<input v-model.number="r.factor" type="number" min="0.1" step="0.1" :disabled="r.force !== 'factor'" />
					<label class="chip"><input v-model="r.force" type="radio" value="fixed" /> {{ game.t('These numbers') }}</label>
					<div v-if="r.force === 'fixed'" class="row wrap">
						<label v-for="u in units" :key="u.id" class="chip">
							{{ u.icon }} {{ game.t(u.name) }}
							<input
								type="number"
								min="0"
								:value="r.fixed[u.id] ?? ''"
								placeholder="0"
								@input="r.fixed[u.id] = Number(($event.target as HTMLInputElement).value) || 0"
							/>
						</label>
					</div>
					<p v-else class="muted">
						{{
							game.t(
								'Each lane sent: one lane of the camp garrison, tier by tier, times this; a tier short is made up with higher tiers of the same family bringing as much attack (attack without bonuses).',
							)
						}}
					</p>
				</fieldset>
				<fieldset>
					<legend>{{ game.t('Formation') }}</legend>
					<label class="chip"
						><input v-model="r.formation" type="radio" value="three" /> {{ game.t('Three lanes in strength (a quick win)') }}</label
					>
					<label class="chip"
						><input v-model="r.formation" type="radio" value="five" /> {{ game.t('All five lanes even (a safe win)') }}</label
					>
					<label class="chip"
						><input v-model="r.shuffle" type="checkbox" /> {{ game.t('Families and lanes at random (as the troops allow)') }}</label
					>
				</fieldset>
				<fieldset>
					<legend>{{ game.t('Hero to lead') }}</legend>
					<label class="chip">
						<input type="checkbox" :checked="!!r.hero" @change="r.hero = r.hero ? null : { ...newPick(), states: [] }" />
						{{ game.t('Send a hero along') }}
					</label>
					<template v-if="r.hero">
						<HeroPicker v-model="r.hero" :heroes="props.heroes" :cities="props.cities" :states="false" />
						<label>
							{{ game.t('No hero at home') }}
							<select v-model="r.heroMissing">
								<option value="without">{{ game.t('go without') }}</option>
								<option value="fail">{{ game.t('wait') }}</option>
							</select>
						</label>
					</template>
				</fieldset>
				<fieldset>
					<legend>{{ game.t('Stop when') }}</legend>
					<label
						>{{ game.t('sent') }}
						<input type="number" min="1" :value="r.stopTimes ?? ''" @input="r.stopTimes = num(($event.target as HTMLInputElement).value)" />
						{{ game.t('times') }}</label
					>
					<label
						>{{ game.t('at') }}
						<input
							type="datetime-local"
							:value="dateInput(r.stopAt)"
							@input="r.stopAt = fromDate(($event.target as HTMLInputElement).value)"
					/></label>
					<label
						>{{ game.t('lost') }}
						<input
							type="number"
							min="1"
							:value="r.stopLosses ?? ''"
							@input="r.stopLosses = num(($event.target as HTMLInputElement).value)"
						/>
						{{ game.t('units') }}</label
					>
					<label
						>{{ game.t('a garrison below') }}
						<input
							type="number"
							min="1"
							:value="r.stopGarrisonBelow ?? ''"
							@input="r.stopGarrisonBelow = num(($event.target as HTMLInputElement).value)"
					/></label>
					<label
						>{{ game.t('defeats in a row') }}
						<input
							type="number"
							min="1"
							:value="r.stopLossStreak ?? ''"
							@input="r.stopLossStreak = num(($event.target as HTMLInputElement).value)"
					/></label>
					<label class="chip"><input v-model="r.stopNoTarget" type="checkbox" /> {{ game.t('no camp is left to raid') }}</label>
				</fieldset>
				<label>
					{{ game.t('When it cannot go ahead') }}
					<select v-model="r.onFail">
						<option value="skip">{{ game.t('policy:skip') }}</option>
						<option value="cancel">{{ game.t('policy:stop-rule') }}</option>
						<option value="block">{{ game.t('policy:block') }}</option>
					</select>
				</label>
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

.row,
fieldset {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 6px 10px;
}

fieldset {
	margin: 0;
	padding: 6px 10px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
}

legend {
	color: var(--muted);
	padding: 0 4px;
}

.chip {
	display: inline-flex;
	align-items: center;
	gap: 4px;
}

input[type='number'] {
	width: 5.5em;
}

.rule {
	display: grid;
	gap: 8px;
	padding: 8px 10px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
}

.tools {
	display: inline-flex;
	gap: 4px;
	margin-left: auto;
}

.muted {
	color: var(--muted);
}

p {
	margin: 0;
}
</style>
