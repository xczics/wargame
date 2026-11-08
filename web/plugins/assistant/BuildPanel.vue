<script setup lang="ts">
// The building queue (docs/design/gameplay.md §15.2): one queue for all settlements, endless; "a bank from 1 to 12" is
// a task a level. Picking a slot reads that settlement's buildings (the data view `buildings.state`, from the store:
// the settlement's page brought it) and the static catalog (which buildings an empty slot offers, their caps); the
// queue itself goes by the scans.
import { computed, ref, watch } from 'vue';
import type { BuildingsState, SettlementOutline, SettlementSummary } from '../../../src/shared/api';
import { type BuildingCatalog, districtLabel, slotsOf as slotsIn } from '../../../src/shared/buildings';
import type { CardsData } from '../../../src/shared/ui';
import { useGame } from '../../core/game';
import Icon from '../../widgets/Icon.vue';
import type { Policy, Store } from './store';
import { type Lean, type Strategy, fillSlots, placeUnique, resourceTargets } from './develop';
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

/* ----- develop a settlement (user 2026-11-08: "新城开发") ----- */
// An outer city's resource buildings by a strategy, or a city's / fortress's repeatable buildings by count; then all of
// them (new and standing) up to one level. From what the browser holds: the settlement's buildings and outline (its
// outer cities' terrain), the catalog.
const devCity = ref('');
/** An outer district's id (resource buildings), or "*" (the whole settlement, by count). */
const devWhere = ref('');
watch(devCity, () => (devWhere.value = ''));
const devState = computed(() => (devCity.value ? (stateOf(devCity.value) ?? null) : null));
const devOutline = computed(() =>
	devCity.value ? (game.data<SettlementOutline | null>('settlements.outline', { settlement: devCity.value }) ?? null) : null,
);
const devSlots = computed(() => (devState.value && catalog.value ? slotsOf(devState.value) : []));
const outerDistricts = computed(() => (devState.value?.settlement.districts ?? []).filter((d) => d.type === 'outer'));
const producesOf = (b: string) => Object.keys(catalog.value?.buildings[b]?.produces ?? {});
const inWhere = computed(() => devSlots.value.filter((s) => devWhere.value === '*' || s.district === devWhere.value));
const offered = computed(() => [...new Set(inWhere.value.flatMap((s) => (s.current ? [s.current.building] : s.options)))]);
// Resource buildings there that may stand more than once: shared out by the strategy. Those that may not (the counting
// house, one per district) are each one tick of their own, on by default (user 2026-11-08: "玩家要勾一下（默认也勾上）：
// 建造钱庄，那就在第一个位置上建上钱庄，然后剩下的按原来的逻辑去做。不勾，就所有的空地都建其他四种资源建筑。").
const uniqueOf = (b: string) => catalog.value?.buildings[b]?.unique;
const resourceChoices = computed(() => offered.value.filter((b) => producesOf(b).length && !uniqueOf(b)));
const uniqueChoices = computed(() => offered.value.filter((b) => producesOf(b).length && uniqueOf(b)));
const included = ref<string[]>([]);
watch(resourceChoices, (list) => (included.value = [...list]), { immediate: true });
const buildUnique = ref<string[]>([]);
watch(uniqueChoices, (list) => (buildUnique.value = [...list]), { immediate: true });
const strategy = ref<Strategy>('even');
const focus = ref('');
watch(included, (list) => (focus.value = list.includes(focus.value) ? focus.value : (list[0] ?? '')));
const leanKind = ref<Lean['kind']>('double');
const leanN = ref(2);
const lean = computed<Lean>(() =>
	leanKind.value === 'double' ? { kind: 'double' } : { kind: leanKind.value, n: Math.max(0, leanN.value || 0) },
);
/** The terrain's percent for a building at the chosen outer city (what it produces there). */
const bonusOf = (b: string) => {
	const d = devOutline.value?.districts.find((x) => x.id === devWhere.value);
	const t = d ? devOutline.value?.terrain?.[`${d.x},${d.y}`] : undefined;
	return producesOf(b).reduce((n, r) => n + (t?.bonus[r] ?? 0), 0);
};
const needsTerrain = computed(
	() => devWhere.value && devWhere.value !== '*' && (strategy.value === 'favour' || strategy.value === 'against'),
);
// By count: the buildings that may stand more than once, how many of each (what stands there to begin with).
const repeatables = computed(() => offered.value.filter((b) => !catalog.value?.buildings[b]?.unique));
const counts = ref<Record<string, number>>({});
const standing = (list: SlotInfo[]) => {
	const out: Record<string, number> = {};
	for (const s of list) if (s.current) out[s.current.building] = (out[s.current.building] ?? 0) + 1;
	return out;
};
watch([devCity, devWhere, repeatables], () => {
	if (devWhere.value !== '*') return;
	const have = standing(devSlots.value);
	counts.value = Object.fromEntries(repeatables.value.map((b) => [b, have[b] ?? 0]));
});
// For the player to go by (user 2026-11-08: "'按数量'的时候，还要提供目前全城的总坑位数（总建筑栏位减去不在清单里的建筑占用的）供玩家参考"):
// every building slot of the settlement but those taken by buildings not in the list, and what the counts add up to.
const pits = computed(() => {
	const listed = new Set(repeatables.value);
	return devSlots.value.filter((s) => !s.current || listed.has(s.current.building)).length;
});
const counted = computed(() => Object.values(counts.value).reduce((n, k) => n + (k || 0), 0));
const devLevel = ref(10);
/** What goes where (new), and which buildings this touches (those standing are raised to the level too). */
const devPlan = computed(() => {
	const empty = inWhere.value.filter((s) => !s.current).map((s) => ({ key: s.key, accepts: s.options }));
	const have = standing(inWhere.value);
	if (devWhere.value === '*') {
		const target = Object.fromEntries(Object.entries(counts.value).filter(([, n]) => n > 0));
		return { fills: fillSlots(empty, have, target), touched: new Set(Object.keys(target)) };
	}
	if (!devWhere.value) return { fills: [], touched: new Set<string>() };
	// The unique ones ticked first, in the first empty slot that takes each, unless one stands (here, or elsewhere in
	// the settlement for one per settlement); the rest of the slots by the strategy.
	const { fills: first, left } = placeUnique(empty, buildUnique.value, (b) =>
		devSlots.value.some((s) => s.current?.building === b && (uniqueOf(b) !== 'district' || s.district === devWhere.value)),
	);
	const touched = new Set([...included.value, ...buildUnique.value]);
	if (!included.value.length) return { fills: first, touched };
	const total =
		included.value.reduce((n, b) => n + (have[b] ?? 0), 0) + left.filter((e) => e.accepts.some((b) => included.value.includes(b))).length;
	const bonus = Object.fromEntries(included.value.map((b) => [b, bonusOf(b)]));
	const target = resourceTargets({
		total,
		buildings: included.value,
		bonus,
		strategy: strategy.value,
		focus: focus.value,
		lean: lean.value,
	});
	return { fills: [...first, ...fillSlots(left, have, target)], touched };
});
/** The tasks it adds: every slot it fills or raises, level by level (all to 1, then all to 2…), none already queued. */
const devTasks = computed(() => {
	if (!devCity.value) return [];
	const steps: { district: string; slot: number; building: string; from: number; to: number }[] = [];
	const filled = new Map(devPlan.value.fills.map((f) => [f.key, f.building]));
	for (const s of inWhere.value) {
		const building = s.current?.building ?? filled.get(s.key);
		if (!building || !devPlan.value.touched.has(building)) continue;
		const cap = s.current?.cap ?? catalog.value?.buildings[building]?.cap ?? devLevel.value;
		steps.push({ district: s.district, slot: s.slot, building, from: s.reaches + 1, to: Math.min(devLevel.value, cap) });
	}
	const out: { district: string; slot: number; building: string; level: number }[] = [];
	const top = Math.max(0, ...steps.map((s) => s.to));
	for (let level = 1; level <= top; level++)
		for (const s of steps)
			if (level >= s.from && level <= s.to && !queuedLevels(devCity.value, s.district, s.slot).has(level)) out.push({ ...s, level });
	return out;
});
const devSummary = computed(() => {
	const n: Record<string, number> = {};
	for (const f of devPlan.value.fills) n[f.building] = (n[f.building] ?? 0) + 1;
	return Object.entries(n)
		.map(([b, k]) => game.t('{0} ×{1}', { 0: buildingName(b), 1: k }))
		.join(game.t(', '));
});
const devAdded = ref<number | null>(null);
function addDevelop() {
	for (const t of devTasks.value) data.build.tasks.push({ id: uid(), settlement: devCity.value, ...t, onFail: policy.value });
	devAdded.value = devTasks.value.length;
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
			<h4>{{ game.t('Develop a settlement') }}</h4>
			<div class="row wrap">
				<select v-model="devCity">
					<option value="">{{ game.t('Settlement…') }}</option>
					<option v-for="c in props.cities" :key="c.id" :value="c.id">{{ game.t(c.name) }} ({{ c.x }}, {{ c.y }})</option>
				</select>
				<span v-if="devCity && !devState" class="muted">{{ game.t('Switch to this settlement once for its slots') }}</span>
				<select v-if="devState" v-model="devWhere">
					<option value="">{{ game.t('What to develop…') }}</option>
					<option v-for="d in outerDistricts" :key="d.id" :value="d.id">
						{{ game.t('{0}: resource buildings', { 0: game.t(districtLabel(d.type, d.idx)) }) }}
					</option>
					<option value="*">{{ game.t('The whole settlement, by count') }}</option>
				</select>
			</div>
			<template v-if="devWhere && devWhere !== '*'">
				<div class="row wrap">
					<label
						>{{ game.t('Strategy') }}
						<select v-model="strategy">
							<option value="even">{{ game.t('strategy:even') }}</option>
							<option value="focus">{{ game.t('strategy:focus') }}</option>
							<option value="favour">{{ game.t('strategy:favour') }}</option>
							<option value="against">{{ game.t('strategy:against') }}</option>
						</select>
					</label>
					<select v-if="strategy === 'focus'" v-model="focus">
						<option v-for="b in included" :key="b" :value="b">{{ buildingName(b) }}</option>
					</select>
					<template v-if="strategy === 'favour' || strategy === 'against'">
						<select v-model="leanKind">
							<option value="double">{{ game.t('lean:double') }}</option>
							<option value="shift">{{ game.t('lean:shift') }}</option>
							<option value="auto">{{ game.t('lean:auto') }}</option>
						</select>
						<input v-if="leanKind !== 'double'" v-model.number="leanN" type="number" min="0" />
					</template>
				</div>
				<div class="row wrap">
					<span class="muted">{{ game.t('Buildings:') }}</span>
					<label v-for="b in resourceChoices" :key="b" class="chip">
						<input v-model="included" type="checkbox" :value="b" /> {{ buildingName(b) }}
						<small v-if="bonusOf(b)" :class="bonusOf(b) > 0 ? 'good' : 'bad'">{{ bonusOf(b) > 0 ? '+' : '' }}{{ bonusOf(b) }}%</small>
					</label>
				</div>
				<div v-if="uniqueChoices.length" class="row wrap">
					<label v-for="b in uniqueChoices" :key="b" class="chip">
						<input v-model="buildUnique" type="checkbox" :value="b" /> {{ game.t('Build a {0}', { 0: buildingName(b) }) }}
					</label>
				</div>
				<p v-if="needsTerrain && !devOutline" class="muted">{{ game.t('Switch to this settlement once for its terrain') }}</p>
			</template>
			<p v-if="devWhere === '*'" class="muted" :class="{ bad: counted > pits }">
				{{
					game.t('Slots for these: {0} (every building slot but those taken by buildings not listed; counts so far: {1})', {
						0: pits,
						1: counted,
					})
				}}
			</p>
			<div v-if="devWhere === '*'" class="row wrap">
				<label v-for="b in repeatables" :key="b" class="chip">
					{{ buildingName(b) }}
					<input v-model.number="counts[b]" type="number" min="0" />
				</label>
			</div>
			<div v-if="devWhere" class="row wrap">
				<label>
					{{ game.t('all up to level') }}
					<input v-model.number="devLevel" type="number" min="1" />
				</label>
				<button type="button" :disabled="!devTasks.length" @click="addDevelop">{{ game.t('Add to the queue') }}</button>
				<span v-if="devAdded !== null" class="muted">{{ game.t('{n} tasks added', { n: devAdded }) }}</span>
			</div>
			<p v-if="devWhere" class="muted">
				{{
					devSummary
						? game.t('New: {0}; {1} tasks', { 0: devSummary, 1: devTasks.length })
						: game.t('Nothing new to build; {0} tasks', { 0: devTasks.length })
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
					<Icon v-if="r.icon" :icon="r.icon" :size="16" /> {{ game.t(r.name) }}
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

.good {
	color: var(--info);
}

.bad {
	color: var(--danger);
}

p {
	margin: 0;
}
</style>
