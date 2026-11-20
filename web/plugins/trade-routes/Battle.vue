<script setup lang="ts">
// The last fight played back (user 2026-11-16: "像素小兵对阵"): our columns on the left, the enemy's front on the right
// with its reserve waiting behind, strike after strike as the server's log has them (the log is what happened), each
// column's squad thinning with its hp. Then what it cost and brought.
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { amount } from '../../../src/shared/format';
import { nameKey } from '../../../src/shared/heroes';
import { rewardName } from '../../../src/shared/i18n';
import type { RouteDef, TradeBattleReport } from '../../../src/shared/trade-routes';
import { useGame } from '../../core/game';
import Line from '../../widgets/Line.vue';
import PixelArt from '../../widgets/PixelArt.vue';
import { foeName } from './foes';
import Portrait from './Portrait.vue';
import Txt from '../../widgets/Txt.vue';
import { frontAt, replay } from './plan';
import { figures, squad } from './soldiers';

const props = defineProps<{ report: TradeBattleReport; route?: RouteDef }>();
const emit = defineEmits<{ close: [] }>();
const game = useGame('trade-routes');
const roster = computed(() => game.view('heroes.roster') ?? []);
const log = computed(() => props.report.log);
const node = computed(() => props.route?.nodes.find((n) => n.id === props.report.node));

const at = ref(0);
const STEP = 450;
let timer: ReturnType<typeof setInterval> | undefined;
const play = () => {
	clearInterval(timer);
	at.value = 0;
	timer = setInterval(() => {
		if (at.value >= log.value.strikes.length) return void clearInterval(timer);
		at.value++;
	}, STEP);
};
watch(() => props.report, play, { immediate: true });
onBeforeUnmount(() => clearInterval(timer));
const skip = () => {
	clearInterval(timer);
	at.value = log.value.strikes.length;
};
const over = computed(() => at.value >= log.value.strikes.length);

const hp = computed(() => replay(log.value, at.value));
const front = computed(() => frontAt(log.value, at.value));
// Enemy columns still waiting: those past the front that have not stepped up yet.
const reserve = computed(() =>
	Math.max(0, log.value.theirs.length - log.value.width - log.value.strikes.slice(0, at.value).filter((s) => s.next).length),
);
const strike = computed(() => (at.value > 0 ? log.value.strikes[at.value - 1] : null));
const maxHp = (id: string) => [...log.value.ours, ...log.value.theirs].find((c) => c.id === id)?.hp ?? 1;

const heroName = (id: string) => {
	const h = roster.value.find((x) => x.id === id);
	return h ? game.t(nameKey(h)) : id;
};
const unitName = (id: string) => {
	const u = game.meta.units?.find((x) => x.id === id);
	return u ? game.t(u.name) : id;
};
const enemyName = (id: string) => {
	const i = Number(id.split('-')[1]);
	const units = node.value?.enemies[i];
	return units && node.value && props.route
		? Object.keys(units)
				.map((u) => foeName(game, props.route!.id, node.value!.chapter, u))
				.join(game.t(', '))
		: game.t('Enemy column {n}', { n: i + 1 });
};
/** The general leading an enemy column ("enemy-<i>"), if any, and the seed of its face (the node panel's too). */
const generalOf = (id: string) => node.value?.generals?.[Number(id.split('-')[1])] ?? null;
const faceSeed = (id: string) => `${node.value?.id}#${id.split('-')[1]}`;
const art = (id: string, family: string | undefined, side: 'ours' | 'theirs') => squad(family, side, figures(hp.value[id], maxHp(id)));
const pct = (id: string) => `${Math.round((100 * hp.value[id]) / maxHp(id))}%`;
/** Who was promoted (as in every battle), by hero: "infantry tier 2 → 3 ×40". */
const promotedLines = computed(() => {
	const by = new Map<string, string[]>();
	for (const p of props.report.promoted ?? [])
		by.set(p.hero, [...(by.get(p.hero) ?? []), game.t('{from} → {to} ×{n}', { from: unitName(p.from), to: unitName(p.to), n: p.count })]);
	return [...by].map(([hero, parts]) => ({ hero, text: parts.join(game.t(', ')) }));
});
const lostLines = computed(() =>
	Object.entries(props.report.lost).map(([hero, units]) => ({
		hero,
		text: Object.entries(units)
			.map(([u, n]) => game.t('{unit} ×{n}', { unit: unitName(u), n }))
			.join(game.t(', ')),
	})),
);
</script>

<template>
	<div class="scrim" @click.self="emit('close')">
		<section class="battle card" role="dialog">
			<header>
				<Portrait :id="node?.portrait" :scale="2" />
				<h3>{{ node?.name ? game.t(node.name) : report.node }}</h3>
			</header>
			<div class="field">
				<div class="side ours">
					<div
						v-for="c in log.ours"
						:key="c.id"
						class="column"
						:class="{ hit: strike?.to === c.id, acting: strike?.from === c.id, down: hp[c.id] <= 0 }"
					>
						<Portrait :seed="c.id" :gender="roster.find((h) => h.id === c.id)?.gender" :scale="1" />
						<PixelArt v-bind="art(c.id, c.family, 'ours')" :scale="3" />
						<small>{{ heroName(c.id) }}</small>
						<div class="bar"><i :style="{ width: pct(c.id) }" /></div>
					</div>
				</div>
				<div class="middle">
					<template v-if="strike">
						<b class="dmg" :class="{ miss: strike.miss, heal: strike.heal }">{{
							strike.heal
								? game.t('+{n} brought back by the surgeons', { n: amount(-strike.damage) })
								: strike.miss
									? game.t('Miss')
									: game.t('-{n}', { n: amount(strike.damage) })
						}}</b>
						<small>{{ game.t('Round {n}', { n: strike.round }) }}</small>
					</template>
				</div>
				<div class="side theirs">
					<div
						v-for="id in front"
						:key="id"
						class="column"
						:class="{ hit: strike?.to === id, acting: strike?.from === id, down: hp[id] <= 0 }"
					>
						<Portrait v-if="generalOf(id)" :seed="faceSeed(id)" :scale="1" />
						<PixelArt v-bind="art(id, log.theirs.find((c) => c.id === id)?.family, 'theirs')" :scale="3" />
						<small>{{ enemyName(id) }}</small>
						<small v-if="generalOf(id)?.surname" class="muted">{{
							game.t(nameKey({ surname: generalOf(id)!.surname!, given: generalOf(id)!.given ?? '' }))
						}}</small>
						<div class="bar enemy"><i :style="{ width: pct(id) }" /></div>
					</div>
					<small v-if="reserve" class="muted">{{ game.t('{n} more columns behind', { n: reserve }) }}</small>
				</div>
			</div>
			<div class="controls">
				<button v-if="!over" type="button" class="secondary" @click="skip">{{ game.t('Skip') }}</button>
				<button v-else type="button" class="secondary" @click="play">{{ game.t('Again') }}</button>
				<button type="button" @click="emit('close')">{{ game.t('Close') }}</button>
			</div>
			<div v-if="over" class="result">
				<p :class="log.won ? 'won' : 'lost'">
					<b>{{ log.won ? game.t('Victory: the place is cleared.') : game.t('Beaten back.') }}</b>
				</p>
				<p v-for="l in lostLines" :key="l.hero" class="muted">{{ game.t('{hero} lost {men}', { hero: heroName(l.hero), men: l.text }) }}</p>
				<p v-for="l in promotedLines" :key="`up-${l.hero}`">
					{{ game.t('{hero} promoted: {men}', { hero: heroName(l.hero), men: l.text }) }}
				</p>
				<p v-for="(s, i) in report.saved" :key="i" class="muted">
					<Txt :text="s.source" /> · {{ game.t('{before} fallen, {after} lost', { before: s.before, after: s.after }) }}
				</p>
				<p v-if="report.exp">{{ game.t('Each hero who fought: {n} experience', { n: amount(report.exp) }) }}</p>
				<p v-for="(n, h) in report.epiphanies" :key="h">
					{{ game.t('{hero} has an epiphany: {n} free points', { hero: heroName(String(h)), n }) }}
				</p>
				<div v-if="report.rewards.length" class="rewards">
					<Line
						v-for="(r, i) in report.rewards"
						:key="i"
						:line="{
							text: rewardName(r),
							...(r.icon ? { icon: r.icon } : {}),
							...(r.rarity ? { rarity: r.rarity } : {}),
							...(r.lost ? { tone: 'warn' as const } : {}),
						}"
					/>
				</div>
			</div>
		</section>
	</div>
</template>

<style scoped>
.scrim {
	position: fixed;
	inset: 0;
	background: var(--scrim);
	display: grid;
	place-items: center;
	z-index: 50;
	padding: 16px;
}

.battle {
	width: min(760px, 100%);
	max-height: 90vh;
	overflow: auto;
	display: grid;
	gap: 10px;
}

.battle h3 {
	margin: 0;
}

.battle header {
	display: flex;
	gap: 10px;
	align-items: center;
}

.field {
	display: grid;
	grid-template-columns: 1fr auto 1fr;
	gap: 8px;
	align-items: center;
	background: var(--field);
	border-radius: var(--radius);
	padding: 12px;
	min-height: 220px;
}

.side {
	display: grid;
	gap: 10px;
	justify-items: center;
}

.column {
	display: grid;
	justify-items: center;
	gap: 2px;
	transition: transform 0.15s;
}

.column.acting.ours,
.ours .column.acting {
	transform: translateX(10px);
}

.theirs .column.acting {
	transform: translateX(-10px);
}

.column.hit {
	animation: shake 0.3s;
}

.column.down {
	opacity: 0.35;
}

.column small {
	color: var(--text);
	text-align: center;
	max-width: 160px;
}

.bar {
	width: 110px;
	height: 6px;
	background: var(--border);
	border-radius: 3px;
	overflow: hidden;
}

.bar i {
	display: block;
	height: 100%;
	background: var(--info);
	transition: width 0.3s;
}

.bar.enemy i {
	background: var(--danger);
}

.middle {
	display: grid;
	justify-items: center;
	min-width: 70px;
}

.dmg {
	color: var(--danger);
	font-size: 1.2em;
}

.dmg.heal {
	color: var(--info);
}

.dmg.miss {
	color: var(--muted);
}

.controls {
	display: flex;
	gap: 8px;
	justify-content: flex-end;
}

.result p {
	margin: 2px 0;
}

.won {
	color: var(--info);
}

.lost {
	color: var(--danger);
}

.rewards {
	display: grid;
	gap: 2px;
}

@keyframes shake {
	0%,
	100% {
		transform: translateX(0);
	}
	25% {
		transform: translateX(-4px);
	}
	75% {
		transform: translateX(4px);
	}
}
</style>
