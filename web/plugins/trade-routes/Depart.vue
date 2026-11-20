<script setup lang="ts">
// Sending a team out (docs/design/gameplay.md §17.2): a settlement, up to three of its free heroes each leading a column
// of one family, its tiers mixed as the player likes (user 2026-11-20: "弓骑步三个兵种三选一，然后等级随意搭配"), the auxiliaries that may go along, and a budget of hours. The cost (their upkeep for the hours), what they
// carry and each hero's limit are worked out here by the same rules; the server checks them again.
import { computed, reactive, ref, watch } from 'vue';
import type { HeroInfo } from '../../../src/shared/api';
import type { UnitCatalog } from '../../../src/shared/api';
import { nameKey } from '../../../src/shared/heroes';
import { asText, costVar } from '../../../src/shared/i18n';
import { aimOf, type RouteDef, type TradeRoutesStatic, troopCap } from '../../../src/shared/trade-routes';
import { useGame } from '../../core/game';
import Txt from '../../widgets/Txt.vue';
import { budgetCost, carryOf, everyone } from './plan';

const props = defineProps<{ route: RouteDef; routes: TradeRoutesStatic }>();
const game = useGame('trade-routes');
const troops = computed(() => game.view('troops.state'));
const roster = computed(() => game.view('heroes.roster') ?? []);
const catalog = computed(() => game.static<UnitCatalog>('troops.units'));
const units = computed(() => game.meta.units ?? []);

const settlement = ref<string>('');
const garrisons = computed(() => troops.value?.garrisons ?? []);
watch(
	garrisons,
	(g) => {
		if (!g.some((x) => x.settlement === settlement.value))
			settlement.value = g.find((x) => x.settlement === game.params.settlement)?.settlement ?? g[0]?.settlement ?? '';
	},
	{ immediate: true },
);
const garrison = computed(() => garrisons.value.find((g) => g.settlement === settlement.value));
const have = (unit: string) => garrison.value?.units.find((u) => u.id === unit)?.count ?? 0;

const free = (h: HeroInfo) => !!game.meta.heroes?.duties.find((d) => d.id === h.duty)?.manual;
const heroes = computed(() => roster.value.filter((h) => h.home === settlement.value && free(h)));
const attrsOf = (h: HeroInfo) => {
	const attrs = { ...h.attrs };
	for (const [a, n] of Object.entries(h.bonus)) attrs[a] = (attrs[a] ?? 0) + n;
	return attrs;
};
const capOf = (h: HeroInfo) => troopCap(props.routes.rules, h.level, attrsOf(h));
const aimPct = (h: HeroInfo) => Math.round(aimOf(props.routes.rules, attrsOf(h)) * 100);
// Units that fight in a column: of a battle family, here.
const fighting = computed(() =>
	units.value.filter((u) => u.family && game.meta.battleFamilies?.some((f) => f.id === u.family) && have(u.id) > 0),
);
const auxiliaries = computed(() => props.routes.auxiliaries.filter((u) => have(u) > 0));

const families = computed(() => (game.meta.battleFamilies ?? []).filter((f) => fighting.value.some((u) => u.family === f.id)));
/** The units of a family here, best tier first. */
const ofFamily = (family: string) => fighting.value.filter((u) => u.family === family).sort((a, b) => (b.tier ?? 0) - (a.tier ?? 0));

type Row = { hero: string; family: string; counts: Record<string, number> };
const rows = reactive<Row[]>([]);
const aux = reactive<Record<string, number>>({});
const addRow = () => rows.push({ hero: '', family: '', counts: {} });
// A new settlement: a new team, one row to fill to begin with.
watch(
	settlement,
	() => {
		rows.splice(0);
		for (const k of Object.keys(aux)) delete aux[k];
		addRow();
	},
	{ immediate: true },
);
const heroOf = (id: string) => roster.value.find((h) => h.id === id);
const menOf = (r: Row) => Object.values(r.counts).reduce((a, n) => a + (n > 0 ? Math.floor(n) : 0), 0);
const capOfRow = (r: Row) => {
	const h = heroOf(r.hero);
	return h ? capOf(h) : 0;
};
/** What the garrison has of a unit left for this row (the other rows take theirs first). */
const left = (r: Row, unit: string) =>
	Math.max(0, have(unit) - rows.filter((x) => x !== r).reduce((a, x) => a + Math.max(0, Math.floor(x.counts[unit] ?? 0)), 0));
// "Most": up to the hero's limit, the best tiers first.
const fill = (r: Row) => {
	let room = capOfRow(r);
	for (const u of ofFamily(r.family)) {
		const n = Math.min(room, left(r, u.id));
		r.counts[u.id] = n;
		room -= n;
	}
};
// Another family: its own tiers to fill.
const pickFamily = (r: Row) => (r.counts = {});

const hours = ref(props.routes.budgets[0] ?? 1);
const team = computed(() =>
	rows
		.filter((r) => r.hero && r.family && menOf(r) > 0)
		.map((r) => ({
			hero: r.hero,
			units: Object.fromEntries(
				Object.entries(r.counts)
					.filter(([, n]) => n > 0)
					.map(([u, n]) => [u, Math.floor(n)]),
			),
		})),
);
const auxPayload = computed(() =>
	Object.fromEntries(
		Object.entries(aux)
			.filter(([, n]) => n > 0)
			.map(([u, n]) => [u, Math.floor(n)]),
	),
);
const all = computed(() => everyone(team.value, auxPayload.value));
const factor = computed(() => (garrison.value?.upkeepBy ?? []).reduce((a, p) => a * p.factor, 1));
const cost = computed(() => (catalog.value ? budgetCost(all.value, catalog.value, hours.value, factor.value) : {}));
const load = computed(() => Object.values(cost.value).reduce((a, b) => a + b, 0));
const carry = computed(() => (catalog.value ? carryOf(all.value, catalog.value) : 0));
const stamina = computed(() => props.routes.rules.perHour * hours.value);
const problem = computed(() => {
	if (!team.value.length) return 'Choose a hero and the men it leads.';
	if (new Set(team.value.map((c) => c.hero)).size !== team.value.length) return 'A hero only once.';
	if (rows.some((r) => menOf(r) > capOfRow(r) || Object.entries(r.counts).some(([u, n]) => n > left(r, u))))
		return 'More men than the hero leads or the garrison has.';
	if (carry.value < load.value) return 'They cannot carry the budget: take supply trains along.';
	return null;
});
const depart = () =>
	game.command(
		'trade-routes.depart',
		{ settlement: settlement.value, route: props.route.id, hours: hours.value, team: team.value, auxiliaries: auxPayload.value },
		{ pending: 'Setting out…' },
	);
const settlementName = (id: string) => {
	const g = garrisons.value.find((x) => x.settlement === id);
	return g ? game.t(g.name) : id;
};
</script>

<template>
	<section class="depart">
		<h3>{{ game.t('Send a team out on {route}', { route: game.t(route.name) }) }}</h3>
		<label
			>{{ game.t('From') }}
			<select v-model="settlement">
				<option v-for="g in garrisons" :key="g.settlement" :value="g.settlement">{{ settlementName(g.settlement) }}</option>
			</select>
		</label>
		<p v-if="!heroes.length" class="muted">{{ game.t('No free hero in this settlement.') }}</p>
		<div v-for="(r, i) in rows" :key="i" class="row">
			<select v-model="r.hero">
				<option value="">{{ game.t('Hero…') }}</option>
				<option v-for="h in heroes" :key="h.id" :value="h.id">
					{{ game.t(nameKey(h)) }} · {{ game.t('Lv {n}', { n: h.level }) }} · {{ game.t('leads {n}', { n: capOf(h) }) }} ·
					{{ game.t('aim {n}%', { n: aimPct(h) }) }}
				</option>
			</select>
			<select v-model="r.family" @change="pickFamily(r)">
				<option value="">{{ game.t('Arm…') }}</option>
				<option v-for="f in families" :key="f.id" :value="f.id">{{ game.t(f.name) }}</option>
			</select>
			<button type="button" class="secondary" :disabled="!r.hero || !r.family" @click="fill(r)">{{ game.t('Most') }}</button>
			<button type="button" class="secondary" @click="rows.splice(i, 1)">×</button>
			<div v-if="r.family" class="tiers">
				<label v-for="u in ofFamily(r.family)" :key="u.id"
					>{{ game.t(u.name) }} ({{ left(r, u.id) }})
					<input v-model.number="r.counts[u.id]" type="number" min="0" :max="left(r, u.id)" />
				</label>
				<small class="muted">{{ game.t('{n} / {cap} men', { n: menOf(r), cap: capOfRow(r) }) }}</small>
			</div>
		</div>
		<button v-if="rows.length < routes.rules.maxHeroes && heroes.length" type="button" class="secondary" @click="addRow">
			{{ game.t('Add a hero') }}
		</button>
		<div v-if="auxiliaries.length" class="aux">
			<label v-for="u in auxiliaries" :key="u"
				>{{ game.t(units.find((x) => x.id === u)?.name ?? u) }} ({{ have(u) }})
				<input v-model.number="aux[u]" type="number" min="0" :max="have(u)" />
			</label>
		</div>
		<label
			>{{ game.t('Budget') }}
			<select v-model.number="hours">
				<option v-for="h in routes.budgets" :key="h" :value="h">{{ game.t('{n} h', { n: h }) }}</option>
			</select>
		</label>
		<p class="muted">
			{{ game.t('Stamina {n}', { n: stamina }) }} ·
			<template v-if="load"
				>{{ game.t('Upkeep for the budget:') }} <Txt :text="asText(costVar(cost, game.meta.resources ?? []))" /> ·
			</template>
			{{ game.t('carry {carry} / {load}', { carry: Math.floor(carry), load }) }}
		</p>
		<p v-if="problem" class="warn">{{ game.t(problem) }}</p>
		<button type="button" :disabled="!!problem" @click="depart">{{ game.t('Set out') }}</button>
	</section>
</template>

<style scoped>
.depart {
	display: grid;
	gap: 6px;
}

.depart h3 {
	margin: 0;
}

.row {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	align-items: center;
}

.row select {
	flex: 1 1 140px;
	min-width: 0;
}

.tiers {
	flex: 1 1 100%;
	display: flex;
	flex-wrap: wrap;
	gap: 4px 10px;
	align-items: center;
}

.tiers input {
	width: 80px;
}

.aux {
	display: grid;
	gap: 4px;
}

.aux input {
	width: 90px;
}

.warn {
	color: var(--danger);
	margin: 0;
}

.muted {
	margin: 0;
}
</style>
