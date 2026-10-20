<script setup lang="ts">
// The building queue (docs/design/gameplay.md §15.2): one queue for all settlements, endless; "a bank from 1 to 12" is
// a task a level. Picking a slot reads that settlement's detail once (on request); the queue itself goes by the scans.
import { computed, ref, watch } from 'vue';
import type { ClientState, SettlementDetail, SettlementSummary } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import type { Policy, Store } from './store';
import { uid } from './store';

const props = defineProps<{ store: Store; cities: SettlementSummary[] }>();
const game = useGame('assistant');
const data = props.store.data;
const buildings = computed(() => game.meta.buildings ?? []);
const resources = computed(() => game.meta.resources ?? []);
const buildingName = (id: string) => game.t(buildings.value.find((b) => b.id === id)?.name ?? id);
const cityName = (id: string) => game.t(props.cities.find((c) => c.id === id)?.name ?? id);

async function details(ids: string[]): Promise<Record<string, SettlementDetail>> {
	if (!ids.length) return {};
	const instances = ids.map((id) => ({ key: id, view: 'settlements.detail', params: { settlement: id } }));
	const state = await game.request<ClientState>(`/api/state?views=&instances=${encodeURIComponent(JSON.stringify(instances))}`);
	return (state.instances ?? {}) as Record<string, SettlementDetail>;
}

/* ----- one slot ----- */
const city = ref('');
const detail = ref<SettlementDetail | null>(null);
watch(city, async (id) => {
	detail.value = null;
	slotKey.value = '';
	if (id) detail.value = (await details([id]))[id] ?? null;
});
const slots = computed(() =>
	(detail.value?.districts ?? []).flatMap((d) =>
		d.slots.map((s) => ({
			key: `${d.id}|${s.slot}`,
			district: d.id,
			slot: s.slot,
			// The settlement's centre first, then its outer cities (the settlements plugin's own words).
			label: `${d.idx ? game.t({ text: 'settlements.Outer city {0}', vars: { 0: d.idx } }) : game.t({ text: 'settlements.Inner city' })} · ${game.t('slot {n}', { n: s.slot + 1 })}: ${
				s.current ? `${buildingName(s.current.building)} ${game.t('Lv {n}', { n: s.current.level })}` : game.t('empty')
			}`,
			current: s.current,
			options: s.options,
		})),
	),
);
const slotKey = ref('');
const chosen = computed(() => slots.value.find((s) => s.key === slotKey.value) ?? null);
const choices = computed(() =>
	chosen.value?.current ? [chosen.value.current.building] : [...new Set((chosen.value?.options ?? []).map((o) => o.building))],
);
const building = ref('');
watch(choices, (c) => (building.value = c[0] ?? ''));
const capOf = (id: string) => chosen.value?.current?.cap ?? buildings.value.find((b) => b.id === id)?.cap ?? 20;
const target = ref(10);
const policy = ref<Policy>('skip');
const queuedLevels = (settlement: string, district: string, slot: number) =>
	new Set(data.build.tasks.filter((t) => t.settlement === settlement && t.district === district && t.slot === slot).map((t) => t.level));
function addOne() {
	const s = chosen.value;
	if (!s || !building.value || !detail.value) return;
	const from = (s.current?.level ?? 0) + 1;
	const have = queuedLevels(detail.value.id, s.district, s.slot);
	for (let level = from; level <= Math.min(target.value, capOf(building.value)); level++)
		if (!have.has(level))
			data.build.tasks.push({
				id: uid(),
				settlement: detail.value.id,
				district: s.district,
				slot: s.slot,
				building: building.value,
				level,
				onFail: policy.value,
			});
}

/* ----- the same building everywhere ----- */
const batchBuilding = ref('');
const batchLevel = ref(10);
const batchCities = ref<string[]>([]);
const batchKinds = ref<string[]>([]);
const kinds = computed(() => [...new Set(props.cities.map((c) => c.kind))]);
const kindName = (k: string) => game.t(game.meta.settlementKinds?.find((x) => x.id === k)?.name ?? k);
const adding = ref(false);
const added = ref<number | null>(null);
async function addBatch() {
	if (!batchBuilding.value) return;
	adding.value = true;
	try {
		const ids = props.cities.filter((c) => batchCities.value.includes(c.id) || batchKinds.value.includes(c.kind)).map((c) => c.id);
		const all = await details(ids);
		let n = 0;
		for (const d of Object.values(all))
			for (const district of d?.districts ?? [])
				for (const s of district.slots) {
					if (s.current?.building !== batchBuilding.value) continue;
					const have = queuedLevels(d.id, district.id, s.slot);
					for (let level = s.current.level + 1; level <= Math.min(batchLevel.value, s.current.cap); level++)
						if (!have.has(level)) {
							data.build.tasks.push({
								id: uid(),
								settlement: d.id,
								district: district.id,
								slot: s.slot,
								building: batchBuilding.value,
								level,
								onFail: policy.value,
							});
							n++;
						}
				}
		added.value = n;
	} finally {
		adding.value = false;
	}
}

const move = (i: number, to: number) => {
	const list = data.build.tasks;
	if (to < 0 || to >= list.length) return;
	const [task] = list.splice(i, 1);
	list.splice(to, 0, task);
};
const reserveCity = ref('');
const reserveOf = computed(() => (reserveCity.value ? (data.build.reserveBy[reserveCity.value] ??= {}) : data.build.reserve));
</script>

<template>
	<div class="panel">
		<section>
			<h4>{{ game.t('Add a slot to the queue') }}</h4>
			<div class="row wrap">
				<select v-model="city">
					<option value="">{{ game.t('Settlement…') }}</option>
					<option v-for="c in props.cities" :key="c.id" :value="c.id">{{ game.t(c.name) }} ({{ c.x }}, {{ c.y }})</option>
				</select>
				<select v-if="slots.length" v-model="slotKey">
					<option value="">{{ game.t('Slot…') }}</option>
					<option v-for="s in slots" :key="s.key" :value="s.key">{{ s.label }}</option>
				</select>
				<select v-if="choices.length" v-model="building">
					<option v-for="b in choices" :key="b" :value="b">{{ buildingName(b) }}</option>
				</select>
				<label v-if="building">
					{{ game.t('up to level') }}
					<input v-model.number="target" type="number" min="1" :max="capOf(building)" />
				</label>
				<button type="button" :disabled="!building" @click="addOne">{{ game.t('Add') }}</button>
			</div>
			<p v-if="chosen && building" class="muted">
				{{
					game.t('{0} levels: {1} → {2}', {
						0: Math.max(0, Math.min(target, capOf(building)) - (chosen.current?.level ?? 0)),
						1: chosen.current?.level ?? 0,
						2: Math.min(target, capOf(building)),
					})
				}}
			</p>
		</section>
		<section>
			<h4>{{ game.t('The same building in several settlements') }}</h4>
			<div class="row wrap">
				<select v-model="batchBuilding">
					<option value="">{{ game.t('Building…') }}</option>
					<option v-for="b in buildings" :key="b.id" :value="b.id">{{ game.t(b.name) }}</option>
				</select>
				<label>
					{{ game.t('up to level') }}
					<input v-model.number="batchLevel" type="number" min="1" />
				</label>
			</div>
			<div class="row wrap">
				<span class="muted">{{ game.t('In') }}</span>
				<label v-for="k in kinds" :key="k" class="chip">
					<input v-model="batchKinds" type="checkbox" :value="k" /> {{ game.t('every {0}', { 0: kindName(k) }) }}
				</label>
				<label v-for="c in props.cities" :key="c.id" class="chip"
					><input v-model="batchCities" type="checkbox" :value="c.id" /> {{ game.t(c.name) }}</label
				>
			</div>
			<div class="row">
				<button type="button" :disabled="!batchBuilding || adding" @click="addBatch">{{ game.t('Add to the queue') }}</button>
				<span v-if="added !== null" class="muted">{{ game.t('{n} tasks added', { n: added }) }}</span>
			</div>
		</section>
		<section>
			<div class="row">
				<h4>{{ game.t('The queue') }} ({{ data.build.tasks.length }})</h4>
				<label class="chip">
					{{ game.t('New tasks, when they cannot go ahead:') }}
					<select v-model="policy">
						<option value="skip">{{ game.t('policy:skip') }}</option>
						<option value="cancel">{{ game.t('policy:cancel') }}</option>
						<option value="block">{{ game.t('policy:block') }}</option>
					</select>
				</label>
			</div>
			<p class="muted">
				{{ game.t('Waiting for resources, a free construction slot or the level before is not a failure: the task just waits.') }}
			</p>
			<ol class="queue">
				<li v-for="(t, i) in data.build.tasks" :key="t.id">
					<span class="what">{{ cityName(t.settlement) }} · {{ buildingName(t.building) }} {{ game.t('Lv {n}', { n: t.level }) }}</span>
					<span v-if="t.note" class="muted note">{{ t.note }}</span>
					<span class="tools">
						<select v-model="t.onFail" :title="game.t('When it cannot go ahead')">
							<option value="skip">{{ game.t('policy:skip') }}</option>
							<option value="cancel">{{ game.t('policy:cancel') }}</option>
							<option value="block">{{ game.t('policy:block') }}</option>
						</select>
						<button type="button" class="small secondary" :title="game.t('To the top')" @click="move(i, 0)">⤒</button>
						<button type="button" class="small secondary" @click="move(i, i - 1)">↑</button>
						<button type="button" class="small secondary" @click="move(i, i + 1)">↓</button>
						<button type="button" class="small secondary" @click="data.build.tasks.splice(i, 1)">✕</button>
					</span>
				</li>
			</ol>
			<button v-if="data.build.tasks.length" type="button" class="small secondary" @click="data.build.tasks.splice(0)">
				{{ game.t('Clear the queue') }}
			</button>
		</section>
		<section>
			<h4>{{ game.t('Keep back') }}</h4>
			<p class="muted">{{ game.t('The queue never spends below these (for training, research...).') }}</p>
			<select v-model="reserveCity">
				<option value="">{{ game.t('Every settlement') }}</option>
				<option v-for="c in props.cities" :key="c.id" :value="c.id">{{ game.t('Only {0}', { 0: game.t(c.name) }) }}</option>
			</select>
			<div class="row wrap">
				<label v-for="r in resources" :key="r.id" class="chip">
					{{ r.icon }} {{ game.t(r.name) }}
					<input v-model.number="reserveOf[r.id]" type="number" min="0" placeholder="0" />
				</label>
			</div>
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

input[type='number'] {
	width: 6em;
}

.queue {
	display: grid;
	gap: 4px;
	margin: 0;
	padding-left: 1.6em;
	max-height: 420px;
	overflow: auto;
}

.queue li {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: 4px 10px;
	padding: 3px 0;
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
</style>
