<script setup lang="ts">
// The building queue (docs/design/gameplay.md §15.2): one queue for all settlements, endless; "a bank from 1 to 12" is
// a task a level. Picking a slot reads that settlement's buildings (the data view `buildings.state`, from the store:
// the settlement's page brought it) and the static catalog (which buildings an empty slot offers, their caps); the
// queue itself goes by the scans.
import { computed, ref, watch } from 'vue';
import type { BuildingsState, SettlementSummary } from '../../../src/shared/api';
import { type BuildingCatalog, districtLabel, slotsOf as slotsIn } from '../../../src/shared/buildings';
import type { CardsData } from '../../../src/shared/ui';
import { useGame } from '../../core/game';
import type { Policy, Store } from './store';
import { move, uid } from './store';

const props = defineProps<{ store: Store; cities: SettlementSummary[] }>();
const game = useGame('assistant');
const data = props.store.data;
const buildings = computed(() => game.meta.buildings ?? []);
const resources = computed(() => game.meta.resources ?? []);
const buildingName = (id: string) => game.t(buildings.value.find((b) => b.id === id)?.name ?? id);
const settlement = game.use('settlement');
const cityName = settlement.name;
const catalogView = computed(() => game.static<CardsData>('buildings.catalog'));
const catalog = computed(() => catalogView.value?.data as BuildingCatalog | undefined);

// What the City page (or this page, with that settlement picked) synced: nothing is fetched for the assistant.
const stateOf = (id: string) => game.data<BuildingsState | null>('buildings.state', { settlement: id });

interface SlotInfo {
	key: string;
	district: string;
	slot: number;
	label: string;
	/** What stands there (or is being built there from nothing, at level 0). */
	current: { building: string; level: number; cap: number } | null;
	/** The level it has once what is being built there is done. */
	reaches: number;
	/** For an empty slot: what it may hold. */
	options: string[];
}
/** A settlement's slots from its buildings and the catalog, as the City page has them (web/plugins/buildings/slots.ts). */
function slotsOf(st: BuildingsState): SlotInfo[] {
	const plans = catalog.value?.buildings ?? {};
	const { slots, taken } = slotsIn(st, plans);
	return slots.map(({ district: d, slot, placed: p, building: c }): SlotInfo => {
		const current = p
			? { building: p.building, level: p.level, cap: p.cap }
			: c
				? { building: c.building, level: 0, cap: plans[c.building]?.cap ?? 1 }
				: null;
		const options = current
			? []
			: (catalogView.value?.choiceSets?.[`${st.settlement.kind}|${d.type}`] ?? [])
					.map((ch) => ch.id ?? '')
					.filter((id) => id && !taken(id, d.id));
		const where = game.t(districtLabel(d.type, d.idx));
		const now = current?.level ? game.t('{0} Lv {1}', { 0: buildingName(current.building), 1: current.level }) : game.t('empty');
		return {
			key: `${d.id}|${slot}`,
			district: d.id,
			slot,
			label: game.t('{0} · slot {1}: {2}', {
				0: where,
				1: slot + 1,
				2: c ? game.t('{0} → {1}', { 0: now, 1: game.t('{0} Lv {1}', { 0: buildingName(c.building), 1: c.targetLevel }) }) : now,
			}),
			current,
			reaches: Math.max(current?.level ?? 0, c?.targetLevel ?? 0),
			options,
		};
	});
}

/* ----- one slot ----- */
const city = ref('');
watch(city, () => (slotKey.value = ''));
const state = computed(() => (city.value ? (stateOf(city.value) ?? null) : null));
const slots = computed(() => (state.value && catalog.value ? slotsOf(state.value) : []));
const slotKey = ref('');
const chosen = computed(() => slots.value.find((s) => s.key === slotKey.value) ?? null);
const choices = computed(() => (chosen.value?.current ? [chosen.value.current.building] : (chosen.value?.options ?? [])));
const building = ref('');
watch(choices, (c) => (building.value = c[0] ?? ''));
const capOf = (id: string) => chosen.value?.current?.cap ?? catalog.value?.buildings[id]?.cap ?? 20;
const target = ref(10);
const policy = ref<Policy>('skip');
const queuedLevels = (settlement: string, district: string, slot: number) =>
	new Set(data.build.tasks.filter((t) => t.settlement === settlement && t.district === district && t.slot === slot).map((t) => t.level));
function addOne() {
	const s = chosen.value;
	if (!s || !building.value || !city.value) return;
	const have = queuedLevels(city.value, s.district, s.slot);
	for (let level = s.reaches + 1; level <= Math.min(target.value, capOf(building.value)); level++)
		if (!have.has(level))
			data.build.tasks.push({
				id: uid(),
				settlement: city.value,
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
const kindName = settlement.kindName;
const adding = ref(false);
const added = ref<number | null>(null);
async function addBatch() {
	if (!batchBuilding.value) return;
	adding.value = true;
	try {
		const ids = props.cities.filter((c) => batchCities.value.includes(c.id) || batchKinds.value.includes(c.kind)).map((c) => c.id);
		let n = 0;
		for (const id of ids) {
			const st = stateOf(id);
			if (!st) continue;
			for (const s of slotsOf(st)) {
				if (s.current?.building !== batchBuilding.value) continue;
				const have = queuedLevels(id, s.district, s.slot);
				for (let level = s.reaches + 1; level <= Math.min(batchLevel.value, s.current.cap); level++)
					if (!have.has(level)) {
						data.build.tasks.push({
							id: uid(),
							settlement: id,
							district: s.district,
							slot: s.slot,
							building: batchBuilding.value,
							level,
							onFail: policy.value,
						});
						n++;
					}
			}
		}
		added.value = n;
	} finally {
		adding.value = false;
	}
}

const moveTo = (i: number, to: number) => move(data.build.tasks, i, to);
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
				<span v-if="city && !state" class="muted">{{ game.t('Switch to this settlement once for its slots') }}</span>
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
						0: Math.max(0, Math.min(target, capOf(building)) - chosen.reaches),
						1: chosen.reaches,
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
					<span class="what">{{ cityName(t.settlement) }} · {{ game.t('{0} Lv {1}', { 0: buildingName(t.building), 1: t.level }) }}</span>
					<span v-if="t.note" class="muted note">{{ t.note }}</span>
					<span class="tools">
						<select v-model="t.onFail" :title="game.t('When it cannot go ahead')">
							<option value="skip">{{ game.t('policy:skip') }}</option>
							<option value="cancel">{{ game.t('policy:cancel') }}</option>
							<option value="block">{{ game.t('policy:block') }}</option>
						</select>
						<button type="button" class="small secondary" :title="game.t('To the top')" @click="moveTo(i, 0)">⤒</button>
						<button type="button" class="small secondary" @click="moveTo(i, i - 1)">↑</button>
						<button type="button" class="small secondary" @click="moveTo(i, i + 1)">↓</button>
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
			<p class="muted">{{ game.t('The building and research queues never spend below these (for training...).') }}</p>
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
