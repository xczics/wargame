<script setup lang="ts">
// The equipment steward's setup (user 2026-11-08: "小助手新增'装备'功能"): when it shares out the pieces, each
// settlement's groups and their order ("捡旧顺序": the first picks first), and what each hero is worked out for, each
// number of its own with a weight (none: 1). The sharing out itself: ./outfit.ts, run by the engine.
import { computed, ref } from 'vue';
import type { HeroInfo, SettlementSummary } from '../../../src/shared/api';
import { nameKey } from '../../../src/shared/heroes';
import { useGame } from '../../core/game';
import type { Store } from './store';
import { move, uid } from './store';

const props = defineProps<{ store: Store; cities: SettlementSummary[] }>();
const game = useGame('assistant');
const { engine } = game.use('assistant');
const data = props.store.data;
const roster = computed(() => game.compute<HeroInfo[]>('heroes.roster', {}) ?? []);
const heroName = (h: HeroInfo) => game.t(nameKey(h));

// Every number a hero may be worked out for, each its own (user: "不能笼统地选'冒险'，而是'冒险-攻击'这种").
const targets = computed(() => [
	...(game.meta.heroes?.attributes ?? []).map((a) => ({ key: `attr:${a.id}`, label: game.t('Attribute: {0}', { 0: game.t(a.name) }) })),
	...['attack', 'defense', 'hp', 'recovery', 'luck'].map((x) => ({ key: `adv:${x}`, label: game.t(`target:adv:${x}`) })),
	...['attack', 'defense', 'hp'].map((x) => ({ key: `flat:${x}`, label: game.t(`target:flat:${x}`) })),
	...['attack', 'defense', 'hp'].map((x) => ({ key: `pct:${x}`, label: game.t(`target:pct:${x}`) })),
	...['production', 'construction', 'training', 'upkeep'].map((x) => ({ key: `gov:${x}`, label: game.t(`target:gov:${x}`) })),
	...['research', 'researchCost'].map((x) => ({ key: `sch:${x}`, label: game.t(`target:sch:${x}`) })),
]);
const labelOf = (key: string) => targets.value.find((x) => x.key === key)?.label ?? key;

/** A settlement's groups: its own (heroes in no group it made, in its order), then those made in it. */
function groupsOf(city: string) {
	const here = roster.value.filter((h) => h.home === city);
	const made = data.equip.groups.filter((g) => g.settlement === city);
	const inMade = new Set(made.flatMap((g) => g.heroes));
	const order = data.equip.order[city] ?? [];
	const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length + 1);
	const own = here.filter((h) => !inMade.has(h.id)).sort((a, b) => rank(a.id) - rank(b.id));
	return [
		{ id: '', name: game.t('Its own group'), heroes: own },
		...made.map((g) => ({ id: g.id, name: g.name, heroes: g.heroes.flatMap((id) => here.filter((h) => h.id === id)) })),
	];
}
/** Moves a hero up or down its group (its own group's order is written out whole the first time). */
function shift(city: string, group: string, list: HeroInfo[], i: number, to: number) {
	if (group) {
		const g = data.equip.groups.find((x) => x.id === group);
		if (g) move(g.heroes, i, to);
		return;
	}
	data.equip.order[city] = list.map((h) => h.id);
	move(data.equip.order[city], i, to);
}
/** Puts a hero in a group of its settlement ("": its own). */
function regroup(city: string, hero: string, to: string) {
	for (const g of data.equip.groups) g.heroes = g.heroes.filter((h) => h !== hero);
	if (to) data.equip.groups.find((g) => g.id === to)?.heroes.push(hero);
	void city;
}
const newName = ref<Record<string, string>>({});
function addGroup(city: string) {
	const name = (newName.value[city] ?? '').trim();
	if (!name) return;
	data.equip.groups.push({ id: uid(), settlement: city, name, heroes: [] });
	newName.value[city] = '';
}
function dropGroup(id: string) {
	const i = data.equip.groups.findIndex((g) => g.id === id);
	if (i >= 0) data.equip.groups.splice(i, 1);
}
const adding = ref<Record<string, string>>({});
function addWant(hero: string) {
	const target = adding.value[hero];
	if (!target) return;
	const list = (data.equip.wants[hero] ??= []);
	if (!list.some((w) => w.target === target)) list.push({ target });
	adding.value[hero] = '';
}
const working = ref(false);
async function now(cities: string[]) {
	working.value = true;
	try {
		await engine.outfitNow(cities);
	} finally {
		working.value = false;
	}
}
</script>

<template>
	<div class="panel">
		<section>
			<div class="row wrap">
				<span class="muted">{{ game.t('Share out the pieces:') }}</span>
				<label class="chip"
					><input v-model="data.equip.when.beforeCamps" type="checkbox" />
					{{ game.t('before the camps assistant sends heroes out') }}</label
				>
				<label class="chip"
					><input v-model="data.equip.when.beforeRealms" type="checkbox" />
					{{ game.t('before the realms assistant sends heroes out') }}</label
				>
				<label class="chip"
					><input v-model="data.equip.when.afterAdventure" type="checkbox" /> {{ game.t('when an adventure is over') }}</label
				>
				<button type="button" :disabled="working" @click="now(props.cities.map((c) => c.id))">{{ game.t('Now, everywhere') }}</button>
			</div>
			<p class="muted">
				{{
					game.t(
						'In each group the first hero picks first, from the settlement’s storage and what the others of its group wear; then the next from what is left. A hero puts a piece on when it raises what it is set to more than what it wears there does (each number by how much it grows, times its weight).',
					)
				}}
			</p>
		</section>
		<section v-for="c in props.cities" :key="c.id">
			<div class="row">
				<h4>{{ game.t(c.name) }}</h4>
				<button type="button" class="small secondary" :disabled="working" @click="now([c.id])">{{ game.t('Now') }}</button>
				<input v-model="newName[c.id]" :placeholder="game.t('New group…')" />
				<button type="button" class="small secondary" @click="addGroup(c.id)">{{ game.t('Add a group') }}</button>
			</div>
			<div v-for="g in groupsOf(c.id)" :key="g.id" class="group">
				<div class="row">
					<strong>{{ g.name }}</strong>
					<button v-if="g.id" type="button" class="small secondary" @click="dropGroup(g.id)">✕</button>
				</div>
				<p v-if="!g.heroes.length" class="muted">{{ game.t('No heroes.') }}</p>
				<ol>
					<li v-for="(h, i) in g.heroes" :key="h.id">
						<div class="row wrap">
							<span>{{ heroName(h) }} · {{ game.t('Lv {0}', { 0: h.level }) }}</span>
							<button type="button" class="small secondary" @click="shift(c.id, g.id, g.heroes, i, i - 1)">↑</button>
							<button type="button" class="small secondary" @click="shift(c.id, g.id, g.heroes, i, i + 1)">↓</button>
							<select :value="g.id" @change="regroup(c.id, h.id, ($event.target as HTMLSelectElement).value)">
								<option v-for="x in groupsOf(c.id)" :key="x.id" :value="x.id">{{ x.name }}</option>
							</select>
						</div>
						<div class="row wrap">
							<span v-for="(w, k) in data.equip.wants[h.id] ?? []" :key="w.target" class="chip want">
								{{ labelOf(w.target) }}
								<input v-model.number="w.weight" type="number" min="0" step="0.1" :placeholder="game.t('weight')" />
								<button type="button" class="small secondary" @click="data.equip.wants[h.id].splice(k, 1)">✕</button>
							</span>
							<select v-model="adding[h.id]" @change="addWant(h.id)">
								<option value="">{{ game.t('Work it out for…') }}</option>
								<option v-for="x in targets" :key="x.key" :value="x.key">{{ x.label }}</option>
							</select>
						</div>
					</li>
				</ol>
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

.want input {
	width: 5em;
}

.group {
	border-left: 2px solid var(--border);
	padding-left: 10px;
}

ol {
	margin: 0;
	padding-left: 1.4em;
	display: grid;
	gap: 6px;
}

.muted {
	color: var(--muted);
}

p {
	margin: 0;
}
</style>
