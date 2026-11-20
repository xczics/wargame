<script setup lang="ts">
// The Trade Routes page (docs/design/gameplay.md §17.2, ui.md): a route's old map, the team out on it (teams are sent from
// the trade post's page: user 2026-11-20 "商路页面只放地图、剧情和战斗"), the place picked on the map with its story and what can be done there, and the last fight played back.
// Everything shown is worked out here from the static routes and the player's state; the server checks every command.
import { computed, ref, watch, watchEffect } from 'vue';
import type { TradeRoutesStatic } from '../../../src/shared/trade-routes';
import { readable } from '../../../src/shared/format';
import { nameKey } from '../../../src/shared/heroes';
import { useGame } from '../../core/game';
import { formatTime } from '../../core/format';
import Icon from '../../widgets/Icon.vue';
import Battle from './Battle.vue';
import NodePanel from './NodePanel.vue';
import Portrait from './Portrait.vue';
import RouteMap from './RouteMap.vue';
import { progress } from './plan';

const game = useGame('trade-routes');
const routes = computed(() => game.static<TradeRoutesStatic>('trade-routes.routes'));
const state = computed(() => game.view('trade-routes.state'));
const expedition = computed(() => state.value?.expedition ?? null);
const roster = computed(() => game.view('heroes.roster') ?? []);

const routeId = ref<string | null>(null);
const list = computed(() => [...(routes.value?.routes ?? [])].sort((a, b) => a.order - b.order));
const route = computed(() => list.value.find((r) => r.id === (routeId.value ?? expedition.value?.route)) ?? list.value[0]);
const selected = ref<string | null>(null);
// The team's place is picked when it moves (and when the page opens on its route).
watch(
	() => expedition.value?.node,
	(node) => {
		if (node) selected.value = node;
	},
	{ immediate: true },
);
watch(route, (r, old) => {
	if (r && old && r.id !== old.id) selected.value = expedition.value?.route === r.id ? expedition.value.node : null;
});
const node = computed(() => route.value?.nodes.find((n) => n.id === selected.value) ?? null);

watchEffect(() => {
	if (expedition.value) game.refreshAt(expedition.value.endsAt);
});

const genderOf = (id: string) => roster.value.find((h) => h.id === id)?.gender;
const heroName = (id: string) => {
	const h = roster.value.find((x) => x.id === id);
	return h ? game.t(nameKey(h)) : id;
};
const unitName = (id: string) => {
	const u = game.meta.units?.find((x) => x.id === id);
	return u ? game.t(u.name) : id;
};
const men = (units: Record<string, number>) =>
	Object.entries(units)
		.filter(([, n]) => n > 0)
		.map(([u, n]) => game.t('{unit} ×{n}', { unit: unitName(u), n }))
		.join(game.t(', '));

// The fight just fought is played back; it opens by itself after a fight, and can be watched again.
const playing = ref(false);
const battle = computed(() => game.view('trade-routes.battle'));
const fought = () => (playing.value = true);

// When a recall would bring the team home (as the server works it out): the time its spent stamina stands for, from
// setting out, at perHour an hour (endsAt counts every gain: less what is left), or now if that is past.
const backIfRecalled = computed(() => {
	const e = expedition.value;
	if (!e || !routes.value) return 0;
	return Math.max(game.serverNow(), e.endsAt - (e.stamina / routes.value.rules.perHour) * 3_600_000);
});
const recalling = ref(false);
const recall = async () => {
	if (!recalling.value) return void (recalling.value = true);
	recalling.value = false;
	await game.command('trade-routes.recall', null, { pending: 'Calling the team home…' });
};
</script>

<template>
	<section class="card trade-routes">
		<p v-if="!routes" class="muted">{{ game.t('Loading…') }}</p>
		<p v-else-if="!list.length" class="muted">{{ game.t('No trade routes yet.') }}</p>
		<template v-else>
			<nav class="routes">
				<button v-for="r in list" :key="r.id" type="button" :class="{ active: route?.id === r.id }" @click="routeId = r.id">
					<b>{{ game.t(r.name) }}</b>
					<small>{{ game.t('{done} / {of} places · chapter {n}', { ...progress(state, r), n: progress(state, r).chapter }) }}</small>
					<Icon v-if="expedition?.route === r.id" icon="flag" />
				</button>
			</nav>
			<div class="body">
				<div class="map-side">
					<RouteMap v-if="route" :route="route" :state="state" :selected="selected" @pick="selected = $event" />
					<p class="muted legend">{{ game.t('Solid paths are opened: walking them takes a third of the stamina.') }}</p>
				</div>
				<aside class="side">
					<section v-if="expedition" class="team">
						<h3><Icon icon="flag" /> {{ game.t('The team') }}</h3>
						<p v-if="expedition.recalled">{{ game.t('On the way home: back at {at}', { at: formatTime(expedition.endsAt) }) }}</p>
						<p v-else>
							{{ game.t('Stamina {n}', { n: readable(expedition.stamina) }) }} ·
							{{ game.t('home at {at}', { at: formatTime(expedition.endsAt) }) }}
						</p>
						<ul>
							<li v-for="c in expedition.team" :key="c.hero" class="member">
								<Portrait :seed="c.hero" :gender="genderOf(c.hero)" :scale="1" />
								<span
									><b>{{ heroName(c.hero) }}</b> · {{ men(c.units) || game.t('no men left') }}</span
								>
							</li>
							<li v-if="Object.keys(expedition.auxiliaries).length" class="muted">{{ men(expedition.auxiliaries) }}</li>
						</ul>
						<div class="actions">
							<button v-if="battle" type="button" class="secondary" @click="playing = true">{{ game.t('Watch the last fight') }}</button>
							<p v-if="!expedition.recalled" class="recall-note">
								{{ game.t('Stop and call home: the team should be back at {at}', { at: formatTime(backIfRecalled) }) }}
								<small class="muted">{{ game.t('How long the way home takes goes by the stamina spent.') }}</small>
							</p>
							<button v-if="!expedition.recalled" type="button" class="secondary" @click="recall">
								{{ recalling ? game.t('Sure? The budget is not given back') : game.t('Call home') }}
							</button>
						</div>
					</section>
					<p v-else class="muted">{{ game.t('Teams set out from a trade post: build one in the outer city.') }}</p>
					<NodePanel v-if="route && node" :route="route" :node="node" :routes="routes" :state="state" @fought="fought" />
				</aside>
			</div>
			<Battle v-if="playing && battle" :report="battle" :route="route" @close="playing = false" />
		</template>
	</section>
</template>

<style scoped>
.recall-note {
	flex: 1 1 100%;
	margin: 0;
	display: grid;
}
.member {
	display: flex;
	gap: 6px;
	align-items: center;
}

.trade-routes {
	display: grid;
	gap: 10px;
}

.routes {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}

.routes button {
	display: grid;
	gap: 0;
	text-align: left;
	background: var(--surface);
	color: var(--text);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 6px 12px;
}

.routes button.active {
	border-color: var(--accent);
	box-shadow: 0 0 0 1px var(--accent);
}

.body {
	display: grid;
	grid-template-columns: minmax(0, 2fr) minmax(260px, 1fr);
	gap: 12px;
	align-items: start;
}

@media (max-width: 860px) {
	.body {
		grid-template-columns: minmax(0, 1fr);
	}
}

.side {
	display: grid;
	gap: 10px;
}

.team ul {
	list-style: none;
	margin: 4px 0;
	padding: 0;
	display: grid;
	gap: 2px;
}

.team h3 {
	margin: 0 0 4px;
}

.team p {
	margin: 0;
}

.actions {
	display: flex;
	flex-wrap: wrap;
	gap: 8px;
}

.legend {
	margin: 4px 0 0;
	font-size: 0.85em;
}
</style>
