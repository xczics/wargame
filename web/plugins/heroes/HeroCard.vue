<script setup lang="ts">
// One hero: name, attributes, where it is attached and what it does; actions for its owner.
import { computed, ref } from 'vue';
import type { HeroInfo } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import RoleEffects from './RoleEffects.vue';

const props = defineProps<{ hero: HeroInfo }>();
const game = useGame();
const heroes = game.use('heroes');
const settlement = game.use('settlement');
const meta = game.meta.heroes;
const duties = new Map((meta?.duties ?? []).map((d) => [d.id, d]));
const manual = (meta?.duties ?? []).filter((d) => d.manual);
const place = (id: string | null) => (id ? game.t(settlement.list.value.find((s) => s.id === id)?.name ?? '') : '');
const busy = computed(() => duties.get(props.hero.duty)?.manual === false);
const duty = ref(props.hero.duty);
const target = ref(props.hero.dutyTarget ?? props.hero.home);
const home = ref(props.hero.home);

// Most duties are held where the hero is attached; only `anywhere` duties pick a place.
const anywhere = computed(() => !!duties.get(duty.value)?.anywhere);
const assign = () =>
	game.command('heroes.assign', {
		hero: props.hero.id,
		duty: duty.value,
		target: duty.value === 'idle' ? null : anywhere.value ? target.value : props.hero.home,
	});
async function move() {
	const post = duties.get(props.hero.duty);
	const ends = props.hero.duty !== 'idle' && !post?.anywhere && home.value !== props.hero.dutyTarget;
	if (
		ends &&
		!confirm(game.t('{name} will leave the post of {duty} there.', { name: heroes.name(props.hero), duty: game.t(post?.name ?? '') }))
	)
		return;
	await game.command('heroes.setHome', { hero: props.hero.id, settlement: home.value });
}
// Free points: picked per attribute, then spent in one command.
const spend = ref<Record<string, number>>({});
const picked = computed(() => Object.values(spend.value).reduce((a, b) => a + b, 0));
const add = (attr: string, n: number) => {
	const next = Math.max(0, (spend.value[attr] ?? 0) + n);
	if (n > 0 && picked.value >= props.hero.freePoints) return;
	spend.value = { ...spend.value, [attr]: next };
};
async function allocate() {
	await game.command('heroes.allocate', { hero: props.hero.id, points: spend.value });
	spend.value = {};
}
const progress = computed(() => (props.hero.expToNext ? Math.min(100, (props.hero.exp / props.hero.expToNext) * 100) : 100));
async function dismiss() {
	if (confirm(game.t('Let {name} go?', { name: heroes.name(props.hero) }))) await game.command('heroes.dismiss', { hero: props.hero.id });
}
</script>

<template>
	<div class="hero">
		<div class="head">
			<strong>{{ hero.gender === 'f' ? '👸' : '🧔' }} {{ heroes.name(hero) }}</strong>
			<small>{{ game.t('Lv {n}', { n: hero.level }) }}</small>
			<span class="badge">{{ game.t(duties.get(hero.duty)?.name ?? hero.duty) }}</span>
			<small v-if="hero.dutyTarget && place(hero.dutyTarget)" class="muted">· {{ place(hero.dutyTarget) }}</small>
		</div>
		<div class="growth">
			<div class="bar" :title="hero.expToNext ? `${hero.exp} / ${hero.expToNext}` : ''"><div :style="{ width: `${progress}%` }"></div></div>
			<small class="muted">
				{{ hero.expToNext ? game.t('Experience {exp} / {need}', { exp: hero.exp, need: hero.expToNext }) : game.t('Highest level') }}
				· {{ game.t('Talent {n}', { n: hero.talent }) }}
			</small>
		</div>
		<ul class="attrs">
			<li v-for="a in meta?.attributes ?? []" :key="a.id">
				<small>{{ game.t(a.name) }}</small>
				<strong :class="{ high: (hero.attrs[a.id] ?? 0) + (hero.bonus[a.id] ?? 0) > 100 }">{{
					(hero.attrs[a.id] ?? 0) + (spend[a.id] ?? 0)
				}}</strong>
				<small v-if="hero.bonus[a.id]" class="bonus">+{{ hero.bonus[a.id] }}</small>
				<small v-if="hero.talents?.[a.id]" class="talent" :title="game.t('Talent: gained every level')">▲{{ hero.talents[a.id] }}</small>
				<span v-if="hero.freePoints" class="pick">
					<button type="button" class="link" :disabled="!spend[a.id]" @click="add(a.id, -1)">−</button>
					<button type="button" class="link" :disabled="picked >= hero.freePoints" @click="add(a.id, 1)">+</button>
				</span>
			</li>
		</ul>
		<div v-if="hero.freePoints" class="row">
			<small>{{ game.t('{n} free points', { n: hero.freePoints - picked }) }}</small>
			<button type="button" class="small" :disabled="!picked" @click="allocate">{{ game.t('Spend points') }}</button>
		</div>
		<small class="muted">{{ game.t('Attached to') }}：{{ place(hero.home) }}</small>
		<RoleEffects :hero="hero" />
		<!-- Sections other plugins put on hero cards (server slot "hero-card"), e.g. adventure numbers. -->
		<component :is="s.component" v-for="(s, i) in game.slot('hero-card')" :key="i" v-bind="s.props" :hero="hero" />
		<form v-if="!busy" class="row" @submit.prevent="assign">
			<select v-model="duty" :aria-label="game.t('Duty')">
				<option v-for="d in manual" :key="d.id" :value="d.id">{{ game.t(d.name) }}</option>
			</select>
			<small v-if="duty !== 'idle' && !anywhere" class="muted">{{ game.t('at {place}', { place: place(hero.home) }) }}</small>
			<select v-if="duty !== 'idle' && anywhere" v-model="target" :aria-label="game.t('At')">
				<option v-for="s in settlement.list.value" :key="s.id" :value="s.id">{{ game.t(s.name) }}</option>
			</select>
			<button type="submit" class="small">{{ game.t('Assign') }}</button>
		</form>
		<form v-if="!busy" class="row" @submit.prevent="move">
			<select v-model="home" :aria-label="game.t('Attached to')">
				<option v-for="s in settlement.list.value" :key="s.id" :value="s.id">{{ game.t(s.name) }}</option>
			</select>
			<button type="submit" class="small secondary">{{ game.t('Move') }}</button>
			<button v-if="hero.duty === 'idle'" type="button" class="link" @click="dismiss">{{ game.t('Dismiss') }}</button>
		</form>
	</div>
</template>

<style scoped>
.hero {
	display: grid;
	gap: 6px;
	padding: 10px 0;
	border-bottom: 1px solid var(--border);
}

.head {
	display: flex;
	gap: 6px;
	align-items: baseline;
	flex-wrap: wrap;
}

.attrs {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	grid-template-columns: repeat(3, 1fr);
	gap: 2px 8px;
	font-variant-numeric: tabular-nums;
}

.high {
	color: var(--accent);
}

.talent {
	color: var(--muted);
}

.bonus {
	color: var(--info);
}

.pick button {
	padding: 0 4px;
}

.growth {
	display: grid;
	gap: 2px;
}

.bar {
	height: 4px;
	border-radius: 2px;
	background: var(--border);
	overflow: hidden;
}

.bar div {
	height: 100%;
	background: var(--accent);
}

.row {
	display: flex;
	gap: 6px;
	flex-wrap: wrap;
	align-items: center;
}

.row select {
	width: auto;
}
</style>
