<script setup lang="ts">
// A place picked on the route's map: its name and story (the novel the routes are written as), who stands there, what
// clearing it opens for trade; and what the team can do about it: walk there, fight for it with columns of its choice
// (no more than the place's width), or buy from the merchant it stands at.
import { computed, ref, watch } from 'vue';
import { amount, readable } from '../../../src/shared/format';
import { nameKey } from '../../../src/shared/heroes';
import { rewardName } from '../../../src/shared/i18n';
import {
	aimOf,
	type RouteDef,
	type RouteNode,
	type TradeGeneral,
	type TradeRoutesState,
	type TradeRoutesStatic,
} from '../../../src/shared/trade-routes';
import { useGame } from '../../core/game';
import Icon from '../../widgets/Icon.vue';
import Line from '../../widgets/Line.vue';
import { foeName } from './foes';
import Portrait from './Portrait.vue';
import { cleared, reachTo } from './plan';

const props = defineProps<{ route: RouteDef; node: RouteNode; routes: TradeRoutesStatic; state?: TradeRoutesState }>();
const emit = defineEmits<{ fought: [] }>();
const game = useGame('trade-routes');
const roster = computed(() => game.view('heroes.roster') ?? []);
const wallet = computed(() => game.view('shop.wallet'));
const expedition = computed(() => props.state?.expedition ?? null);
const here = computed(() => expedition.value?.route === props.route.id && expedition.value.node === props.node.id);
const done = computed(() => cleared(props.state, props.route, props.node.id));
const step = computed(() => reachTo(props.state, props.route, props.routes.rules, props.node));

/** An enemy column's general: its name, level and build, its attributes (in the heroes' order), its aim. */
const generalText = (g: TradeGeneral) => {
	const attrs = g.attrs ?? {};
	return game.t('{name} · Lv {level} {build}: {attrs} · aim {aim}%', {
		name: g.surname ? game.t(nameKey({ surname: g.surname, given: g.given ?? '' })) : '',
		level: g.level,
		build: g.build ? game.t(g.build) : '',
		attrs: (game.meta.heroes?.attributes ?? [])
			.filter((a) => attrs[a.id])
			.map((a) => game.t('{attr} {n}', { attr: game.t(a.name), n: Math.round(attrs[a.id]) }))
			.join(game.t(', ')),
		aim: Math.round(aimOf(props.routes.rules, attrs) * 100),
	});
};
const resName = (id: string) => {
	const r = game.meta.resources?.find((x) => x.id === id);
	return r ? game.t(r.name) : id;
};
const heroName = (id: string) => {
	const h = roster.value.find((x) => x.id === id);
	return h ? game.t(nameKey(h)) : id;
};
/** The story's paragraphs (a blank line between them in the text). */
const story = computed(() => (props.node.text ? game.t(props.node.text).split(/\n\s*\n/) : []));
const ending = computed(() => (props.node.after ? game.t(props.node.after).split(/\n\s*\n/) : []));

// Which columns fight: the first ones that still have men, as many as the place takes.
const columns = computed(() => (expedition.value?.team ?? []).filter((c) => Object.values(c.units).some((n) => n > 0)));
const chosen = ref<string[]>([]);
watch(
	() => [props.node.id, columns.value.length],
	() => (chosen.value = columns.value.slice(0, props.node.width).map((c) => c.hero)),
	{ immediate: true },
);
const toggle = (hero: string) => {
	if (chosen.value.includes(hero)) chosen.value = chosen.value.filter((h) => h !== hero);
	else if (chosen.value.length < props.node.width) chosen.value = [...chosen.value, hero];
};
// A neighbour is a step; farther over opened ground, one travel (the server walks it and writes once).
const move = () =>
	step.value?.kind === 'travel'
		? game.command('trade-routes.travel', { node: props.node.id }, { pending: 'On the way…' })
		: game.command('trade-routes.move', { node: props.node.id }, { pending: 'On the way…' });
const fight = async () => {
	const from = step.value?.from;
	if (from && from !== expedition.value?.node && !(await game.command('trade-routes.travel', { node: from }, { pending: 'On the way…' })))
		return;
	if (await game.command('trade-routes.fight', { node: props.node.id, heroes: chosen.value }, { pending: 'Fighting…' })) emit('fought');
};

const merchant = computed(() => (here.value && props.node.kind === 'merchant' ? game.view('trade-routes.merchant') : null));
const buy = (goods: string) => game.command('trade-routes.buy', { goods }, { pending: 'Buying…' });
/** A piece's numbers, named as its base names them. */
const statsLine = (stats: Record<string, number> | undefined, base: string | undefined) => {
	const labels = game.meta.equipment?.bases.find((b) => b.id === base)?.labels ?? '';
	return Object.entries(stats ?? {})
		.map(([s, n]) => {
			const attr = s.startsWith('attr.') ? game.meta.heroes?.attributes.find((a) => a.id === s.slice(5))?.name : undefined;
			return game.t('{stat} +{n}', { stat: game.t(attr ?? `${labels}${s}`), n: amount(n) });
		})
		.join(game.t(', '));
};
</script>

<template>
	<section class="node">
		<Portrait :id="node.portrait" />
		<h3>
			{{ node.name ? game.t(node.name) : node.id }}
			<small class="muted"
				>{{ game.t(`kind:${node.kind}`) }}<template v-if="done && node.kind !== 'start'"> · {{ game.t('cleared') }}</template></small
			>
		</h3>
		<!-- The story's first part before the fight, its end once the guards are beaten (user 2026-11-20: "剧情有两部分：打之前
		给看一部分，然后显示目前有些敌军。然后我们打完之后，再补全剩下的部分"); the shop and the stores only then. -->
		<div class="story">
			<p v-for="(p, i) in story" :key="i">{{ p }}</p>
			<template v-if="done || !node.enemies.length">
				<p v-for="(p, i) in ending" :key="`after-${i}`" class="after">{{ p }}</p>
			</template>
		</div>
		<p v-if="node.kind === 'lair' && done && expedition?.raided?.includes(node.id)" class="muted">
			{{ game.t('Beaten this time out: it can be fought again the next time out.') }}
		</p>
		<div v-if="done && (node.first || node.pass)" class="supply">
			<p v-if="node.first">{{ game.t(node.first) }}</p>
			<p v-if="node.pass" class="muted">{{ game.t('Each time out, passing by: {text}', { text: game.t(node.pass) }) }}</p>
		</div>
		<div v-if="node.enemies.length && (!done || node.kind === 'lair')" class="enemies">
			<b>{{ game.t('Enemy columns, front first ({n} fight at once)', { n: node.width }) }}</b>
			<ol>
				<li v-for="(c, i) in node.enemies" :key="i">
					{{
						Object.entries(c)
							.map(([u, n]) => game.t('{unit} ×{n}', { unit: foeName(game, route.id, node.chapter, u), n }))
							.join(game.t(', '))
					}}
					<Portrait v-if="node.generals?.[i]" :seed="`${node.id}#${i}`" :scale="1" />
					<small class="muted general">
						{{ node.generals?.[i] ? generalText(node.generals[i]!) : game.t('No one leads them') }}
					</small>
				</li>
			</ol>
		</div>
		<div v-if="node.unlock" class="unlock">
			<b>{{ done ? game.t('Opened for trade') : game.t('Clearing it opens for trade') }}</b>
			<ul>
				<li v-for="o in node.unlock.orders" :key="o.id">
					{{ game.t('{to} {n} a day, for {from}', { to: resName(o.to), n: o.amount, from: resName(o.from) }) }}
				</li>
				<li v-if="node.unlock.loss">{{ game.t('{n} points off the loss', { n: node.unlock.loss }) }}</li>
			</ul>
		</div>

		<div v-if="step" class="act">
			<template v-if="step.kind !== 'fight'">
				<button type="button" :disabled="step.short" @click="move">
					{{
						step.via > 1
							? game.t('Go there (stamina {n}, by {k} places)', { n: readable(step.cost), k: step.via })
							: game.t('Go there (stamina {n})', { n: readable(step.cost) })
					}}
				</button>
			</template>
			<template v-else>
				<p class="muted">{{ game.t('Who fights (at most {n}):', { n: node.width }) }}</p>
				<label v-for="c in columns" :key="c.hero" class="pick">
					<input type="checkbox" :checked="chosen.includes(c.hero)" @change="toggle(c.hero)" />
					{{ heroName(c.hero) }}
				</label>
				<button type="button" :disabled="step.short || !chosen.length" @click="fight">
					{{
						step.via > 0
							? game.t('Go and fight (stamina {n}, by {k} places)', { n: readable(step.cost), k: step.via })
							: game.t('Fight (stamina {n})', { n: readable(step.cost) })
					}}
				</button>
			</template>
			<p v-if="step.short" class="muted">{{ game.t('Not enough stamina.') }}</p>
		</div>

		<div v-if="merchant" class="merchant">
			<b>{{ game.t("Today's goods") }}</b>
			<span v-if="wallet" class="muted"> · <Icon icon="yuanbao" />{{ wallet.balance }}</span>
			<ul>
				<li v-for="g in merchant.goods" :key="g.id">
					<Line
						:line="{
							text: rewardName(g.preview),
							...(g.preview.icon ? { icon: g.preview.icon } : {}),
							...(g.preview.rarity ? { rarity: g.preview.rarity } : {}),
						}"
					/>
					<small v-if="g.preview.stats" class="muted">{{ statsLine(g.preview.stats, g.preview.base) }}</small>
					<span class="buy">
						<Icon icon="yuanbao" />{{ g.price }}
						<button type="button" :disabled="g.bought >= g.limit || (wallet ? wallet.balance < g.price : false)" @click="buy(g.id)">
							{{ g.bought >= g.limit ? game.t('Sold out') : game.t('Buy') }}
						</button>
					</span>
				</li>
			</ul>
		</div>
	</section>
</template>

<style scoped>
.node {
	display: grid;
	gap: 6px;
	padding: 10px 12px;
	background: var(--map-paper);
	color: var(--map-ink);
	border: 1px solid var(--map-paper-edge);
	border-radius: var(--radius);
}

.node h3 {
	margin: 0;
	font-family: 'Songti SC', 'STSong', 'SimSun', serif;
}

.supply p {
	margin: 0 0 4px;
	text-indent: 2em;
}

.story p {
	margin: 0 0 6px;
	text-indent: 2em;
	line-height: 1.8;
	font-family: 'Songti SC', 'STSong', 'SimSun', serif;
}

.general {
	display: block;
}

.enemies ol,
.unlock ul,
.merchant ul {
	margin: 2px 0;
	padding-left: 20px;
}

.merchant ul {
	list-style: none;
	padding: 0;
	display: grid;
	gap: 6px;
}

.merchant li {
	display: grid;
	gap: 2px;
}

.buy {
	display: flex;
	gap: 6px;
	align-items: center;
}

.act {
	display: grid;
	gap: 4px;
}

.pick {
	display: flex;
	gap: 6px;
	align-items: center;
}

.muted {
	color: inherit;
	opacity: 0.7;
	margin: 0;
}
</style>
