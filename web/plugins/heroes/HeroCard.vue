<script setup lang="ts">
// One hero: name, attributes, where it is attached and what it does; actions for its owner.
import { computed, ref } from 'vue';
import type { HeroInfo } from '../../../src/shared/api';
import { useGame } from '../../core/game';

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
async function dismiss() {
	if (confirm(game.t('Let {name} go?', { name: heroes.name(props.hero) }))) await game.command('heroes.dismiss', { hero: props.hero.id });
}
</script>

<template>
	<div class="hero">
		<div class="head">
			<strong>{{ hero.gender === 'f' ? '👸' : '🧔' }} {{ heroes.name(hero) }}</strong>
			<span class="badge">{{ game.t(duties.get(hero.duty)?.name ?? hero.duty) }}</span>
			<small v-if="hero.dutyTarget && place(hero.dutyTarget)" class="muted">· {{ place(hero.dutyTarget) }}</small>
		</div>
		<ul class="attrs">
			<li v-for="a in meta?.attributes ?? []" :key="a.id">
				<small>{{ game.t(a.name) }}</small> <strong :class="{ high: (hero.attrs[a.id] ?? 0) > 100 }">{{ hero.attrs[a.id] ?? 0 }}</strong>
			</li>
		</ul>
		<small class="muted">{{ game.t('Attached to') }}：{{ place(hero.home) }}</small>
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
