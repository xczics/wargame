<script setup lang="ts">
// The selected settlement's gear: what its heroes wear and what it stores (its armory). Only
// heroes attached to it can take stored pieces. Rarity sets the name's colour.
import { computed, ref, watch } from 'vue';
import type { EquipmentPiece, HeroInfo } from '../../../src/shared/api';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

const game = useGame();
const heroes = game.use('heroes');
const settlement = game.use('settlement');
const meta = game.meta.equipment;
const attrNames = new Map((game.meta.heroes?.attributes ?? []).map((a) => [a.id, a.name]));
const icons = new Map((game.meta.resources ?? []).map((r) => [r.id, r.icon ?? r.id]));
const bag = computed(() => game.view('equipment.bag'));
const here = computed(() => settlement.current.value?.id ?? '');
const list = computed(() => (game.view('heroes.list') ?? []).filter((h) => h.home === here.value));
const room = computed(() => bag.value?.storage[here.value]);
const hero = ref('');
watch(
	list,
	(l) => {
		if (!l.some((h) => h.id === hero.value)) hero.value = l[0]?.id ?? '';
	},
	{ immediate: true },
);
const current = computed(() => list.value.find((h) => h.id === hero.value));
const worn = computed(() => new Map((bag.value?.pieces ?? []).filter((p) => p.hero === hero.value).map((p) => [p.slot, p])));
const loose = computed(() => (bag.value?.pieces ?? []).filter((p) => !p.hero && p.settlement === here.value));
const nameOf = (id: string | null) => {
	const h = list.value.find((x) => x.id === id);
	return h ? heroes.name(h as HeroInfo) : '';
};

const statText = (key: string, v: number) => {
	const label = key.startsWith('attr.') ? game.t(attrNames.get(key.slice(5)) ?? key) : game.t(`stat:${key}`);
	return `${label} +${formatNumber(v, { decimals: 1 })}`;
};
const stats = (p: EquipmentPiece) =>
	Object.entries(p.stats)
		.map(([k, v]) => statText(k, v))
		.join(' · ');
const smeltText = (p: EquipmentPiece) =>
	Object.entries(bag.value?.smelt[p.id] ?? {})
		.map(([r, n]) => `${icons.get(r) ?? r}${formatNumber(n)}`)
		.join(' ');
const wear = (p: EquipmentPiece) => game.command('equipment.equip', { piece: p.id, hero: hero.value });
const off = (p: EquipmentPiece) => game.command('equipment.unequip', { piece: p.id });
async function smelt(p: EquipmentPiece) {
	if (confirm(game.t('Smelt this piece?'))) await game.command('equipment.smelt', { piece: p.id });
}
</script>

<template>
	<section v-if="bag" class="card">
		<h2>{{ game.t('Equipment') }}</h2>
		<select v-if="list.length" v-model="hero" class="pick">
			<option v-for="h in list" :key="h.id" :value="h.id">{{ heroes.name(h as HeroInfo) }}</option>
		</select>
		<ul v-if="current" class="slots">
			<li v-for="s in meta?.slots ?? []" :key="s.id">
				<small class="muted">{{ game.t(s.name) }}</small>
				<template v-if="worn.get(s.id)">
					<span :class="`r-${worn.get(s.id)!.rarity}`">{{ worn.get(s.id)!.icon }} {{ game.t(worn.get(s.id)!.name) }}</span>
					<small>{{ stats(worn.get(s.id)!) }}</small>
					<button type="button" class="link" @click="off(worn.get(s.id)!)">{{ game.t('Take off') }}</button>
				</template>
				<small v-else class="muted">—</small>
			</li>
		</ul>
		<h3>{{ game.t('Stored here {n} / {cap}', { n: room?.used ?? 0, cap: room?.capacity ?? 0 }) }}</h3>
		<p v-if="!loose.length" class="muted">{{ game.t('Nothing stored here. Equipment drops in realms; an armory stores more.') }}</p>
		<ul class="bag">
			<li v-for="p in loose" :key="p.id">
				<div>
					<strong :class="`r-${p.rarity}`">{{ p.icon }} {{ game.t(p.name) }}</strong>
					<small class="muted">
						· {{ game.t(`rarity:${p.rarity}`) }} · {{ game.t(meta?.slots.find((s) => s.id === p.slot)?.name ?? p.slot) }} ·
						{{ game.t('Tier {n}', { n: p.tier }) }}</small
					>
				</div>
				<small>{{ stats(p) }}</small>
				<div class="row">
					<button v-if="current" type="button" class="small" @click="wear(p)">{{ game.t('Wear') }}</button>
					<button type="button" class="small secondary" @click="smelt(p)">{{ game.t('Smelt ({value})', { value: smeltText(p) }) }}</button>
				</div>
			</li>
		</ul>
		<small v-if="bag.pieces.some((p) => p.hero && p.hero !== hero && list.some((h) => h.id === p.hero))" class="muted">
			{{
				bag.pieces
					.filter((p) => p.hero && p.hero !== hero && list.some((h) => h.id === p.hero))
					.map((p) => `${game.t(p.name)}（${game.t('worn by {name}', { name: nameOf(p.hero) })}）`)
					.join('、')
			}}
		</small>
	</section>
</template>

<style scoped>
.pick {
	width: auto;
	margin-bottom: 8px;
}

.slots,
.bag {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 6px;
}

.slots li {
	display: flex;
	gap: 8px;
	align-items: baseline;
	flex-wrap: wrap;
}

.bag li {
	display: grid;
	gap: 3px;
	padding: 6px 0;
	border-bottom: 1px solid var(--border);
}

.row {
	display: flex;
	gap: 6px;
}

h3 {
	margin: 12px 0 4px;
}

.r-common {
	color: var(--muted);
}

.r-rare {
	color: var(--info);
}

.r-epic {
	color: var(--accent);
}

.r-legendary {
	color: var(--danger);
}
</style>
