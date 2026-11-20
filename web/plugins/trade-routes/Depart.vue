<script setup lang="ts">
// Sending a team out (docs/design/gameplay.md §17.2), on the trade post's page (user 2026-11-20: "把派出表单整体挪到商路开拓的
// 建筑页面。商路页面只放地图、剧情和战斗"): the post's settlement, a route, up to three of its idle heroes (not one in
// office: "已有任职的英雄不应出现在商路的派出界面") each leading a column of one family, its tiers mixed as the player likes
// ("弓骑步三个兵种三选一，然后等级随意搭配"), the auxiliaries that may go along, and a budget of hours. Laid out as cards
// (user 2026-11-20: "就是三个卡片，每个卡片对应一个'空白用户'的立绘，然后点击选择英雄……在一群可用英雄立绘卡片里挑，挑完选
// 兵种、选完填（或拉进度条）各个等级带多少兵。然后下面再放一个公共的后勤卡片"). The cost (their upkeep for the hours), what
// they carry and each hero's limit are worked out here by the same rules; the server checks them again.
import { computed, reactive, ref, watch } from 'vue';
import type { HeroInfo } from '../../../src/shared/api';
import type { UnitCatalog } from '../../../src/shared/api';
import { nameKey } from '../../../src/shared/heroes';
import { asText, costVar } from '../../../src/shared/i18n';
import { aimOf, type TradeRoutesStatic, troopCap } from '../../../src/shared/trade-routes';
import { useGame } from '../../core/game';
import Txt from '../../widgets/Txt.vue';
import Portrait from './Portrait.vue';
import { budgetCost, carryOf, everyone } from './plan';

const props = defineProps<{ routes: TradeRoutesStatic; settlement: string }>();
const game = useGame('trade-routes');
const troops = computed(() => game.view('troops.state'));
const roster = computed(() => game.view('heroes.roster') ?? []);
const catalog = computed(() => game.static<UnitCatalog>('troops.units'));
const units = computed(() => game.meta.units ?? []);

const list = computed(() => [...props.routes.routes].sort((a, b) => a.order - b.order));
const routeId = ref(list.value[0]?.id ?? '');
const route = computed(() => list.value.find((r) => r.id === routeId.value) ?? list.value[0]);
const settlement = computed(() => props.settlement);
const garrison = computed(() => troops.value?.garrisons.find((g) => g.settlement === settlement.value));
const have = (unit: string) => garrison.value?.units.find((u) => u.id === unit)?.count ?? 0;

const heroes = computed(() => roster.value.filter((h) => h.home === settlement.value && h.duty === 'idle'));
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
// The card whose hero is being chosen (the heroes' cards open under the team), or null.
const picking = ref<number | null>(null);
// One card a hero the team may take (three), each empty to begin with.
const rows = reactive<Row[]>([]);
const aux = reactive<Record<string, number>>({});
watch(
	settlement,
	() => {
		rows.splice(0);
		for (const k of Object.keys(aux)) delete aux[k];
		for (let i = 0; i < props.routes.rules.maxHeroes; i++) rows.push({ hero: '', family: '', counts: {} });
		picking.value = null;
	},
	{ immediate: true },
);
const choosable = computed(() => heroes.value.filter((h) => !rows.some((r, i) => i !== picking.value && r.hero === h.id)));
const pick = (h: HeroInfo) => {
	const r = rows[picking.value!];
	if (r.hero !== h.id) Object.assign(r, { hero: h.id, family: r.family, counts: {} });
	picking.value = null;
};
const clear = (r: Row) => Object.assign(r, { hero: '', family: '', counts: {} });
const setFamily = (r: Row, family: string) => {
	if (r.family !== family) Object.assign(r, { family, counts: {} });
};
const clamp = (n: number, max: number) => Math.max(0, Math.min(max, Math.floor(Number(n) || 0)));
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
		{ settlement: settlement.value, route: route.value.id, hours: hours.value, team: team.value, auxiliaries: auxPayload.value },
		{ pending: 'Setting out…' },
	);
</script>

<template>
	<section class="depart">
		<h4>{{ game.t('Send a team out') }}</h4>
		<label
			>{{ game.t('Route') }}
			<select v-model="routeId">
				<option v-for="r in list" :key="r.id" :value="r.id">{{ game.t(r.name) }}</option>
			</select>
		</label>
		<p v-if="!heroes.length" class="muted">{{ game.t('No free hero in this settlement.') }}</p>
		<div class="team">
			<article v-for="(r, i) in rows" :key="i" class="card slot" :class="{ open: picking === i }">
				<button type="button" class="face" :title="game.t('Choose a hero')" @click="picking = picking === i ? null : i">
					<Portrait v-if="heroOf(r.hero)" :seed="r.hero" :gender="heroOf(r.hero)!.gender" :scale="2" />
					<span v-else class="blank" aria-hidden="true"></span>
				</button>
				<template v-if="heroOf(r.hero)">
					<b>{{ game.t(nameKey(heroOf(r.hero)!)) }}</b>
					<small class="muted"
						>{{ game.t('Lv {n}', { n: heroOf(r.hero)!.level }) }} · {{ game.t('leads {n}', { n: capOfRow(r) }) }} ·
						{{ game.t('aim {n}%', { n: aimPct(heroOf(r.hero)!) }) }}</small
					>
					<div class="arms">
						<button
							v-for="f in families"
							:key="f.id"
							type="button"
							:class="r.family === f.id ? 'active' : 'secondary'"
							@click="setFamily(r, f.id)"
						>
							{{ game.t(f.name) }}
						</button>
					</div>
					<template v-if="r.family">
						<label v-for="u in ofFamily(r.family)" :key="u.id" class="tier"
							><span
								>{{ game.t(u.name) }} <small class="muted">({{ left(r, u.id) }})</small></span
							>
							<input
								type="range"
								min="0"
								:max="Math.min(left(r, u.id), capOfRow(r))"
								:value="r.counts[u.id] ?? 0"
								@input="r.counts[u.id] = clamp(Number(($event.target as HTMLInputElement).value), left(r, u.id))"
							/>
							<input v-model.number="r.counts[u.id]" type="number" min="0" :max="left(r, u.id)" />
						</label>
						<div class="sum">
							<small :class="menOf(r) > capOfRow(r) ? 'warn' : 'muted'">{{
								game.t('{n} / {cap} men', { n: menOf(r), cap: capOfRow(r) })
							}}</small>
							<button type="button" class="secondary" @click="fill(r)">{{ game.t('Most') }}</button>
						</div>
					</template>
					<button type="button" class="secondary drop" @click="clear(r)">{{ game.t('Leave out') }}</button>
				</template>
				<small v-else class="muted">{{ game.t('Choose a hero') }}</small>
			</article>
		</div>
		<div v-if="picking !== null" class="card picker">
			<p v-if="!choosable.length" class="muted">{{ game.t('No free hero in this settlement.') }}</p>
			<button v-for="h in choosable" :key="h.id" type="button" class="secondary who" @click="pick(h)">
				<Portrait :seed="h.id" :gender="h.gender" :scale="1" />
				<span
					><b>{{ game.t(nameKey(h)) }}</b
					><br /><small
						>{{ game.t('Lv {n}', { n: h.level }) }} · {{ game.t('leads {n}', { n: capOf(h) }) }} ·
						{{ game.t('aim {n}%', { n: aimPct(h) }) }}</small
					></span
				>
			</button>
		</div>
		<article v-if="auxiliaries.length" class="card aux">
			<b>{{ game.t('Logistics') }}</b>
			<label v-for="u in auxiliaries" :key="u" class="tier"
				><span
					>{{ game.t(units.find((x) => x.id === u)?.name ?? u) }} <small class="muted">({{ have(u) }})</small></span
				>
				<input
					type="range"
					min="0"
					:max="have(u)"
					:value="aux[u] ?? 0"
					@input="aux[u] = clamp(Number(($event.target as HTMLInputElement).value), have(u))"
				/>
				<input v-model.number="aux[u]" type="number" min="0" :max="have(u)" />
			</label>
		</article>
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
	gap: 8px;
}

.depart h4,
.muted,
.warn {
	margin: 0;
}

.team {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
	gap: 8px;
}

.slot {
	display: grid;
	gap: 4px;
	justify-items: center;
	align-content: start;
	text-align: center;
}

.slot.open {
	outline: 2px solid var(--accent);
}

.face {
	padding: 0;
	background: none;
	border: none;
	cursor: pointer;
}

.blank {
	display: block;
	width: 64px;
	height: 64px;
	border: 2px dashed var(--border);
	border-radius: 4px;
	background:
		radial-gradient(circle at 50% 36%, var(--border) 0 13px, transparent 14px),
		radial-gradient(ellipse at 50% 100%, var(--border) 0 24px, transparent 25px);
}

.arms {
	display: flex;
	flex-wrap: wrap;
	gap: 4px;
	justify-content: center;
}

.tier {
	display: grid;
	grid-template-columns: 1fr 72px;
	gap: 2px 6px;
	align-items: center;
	width: 100%;
	text-align: left;
}

.tier span {
	grid-column: 1 / -1;
}

.tier input[type='range'] {
	width: 100%;
}

.tier input[type='number'] {
	width: 72px;
}

.sum {
	display: flex;
	gap: 6px;
	align-items: center;
	justify-content: space-between;
	width: 100%;
}

.picker {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
	gap: 6px;
}

.who {
	display: flex;
	gap: 6px;
	align-items: center;
	text-align: left;
}

.aux {
	display: grid;
	gap: 6px;
}

.warn {
	color: var(--danger);
}
</style>
