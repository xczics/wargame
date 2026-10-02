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
const regularSlots = computed(() => (meta?.slots ?? []).filter((s) => !s.group));
// Accessories: one row of as many cells as this hero may wear (women only), filled with what she wears.
const accessoryLimit = computed(() => bag.value?.groups[hero.value]?.accessory ?? 0);
const accessories = computed(() => {
	const on = [...worn.value.values()].filter((p) => meta?.slots.find((s) => s.id === p.slot)?.group === 'accessory');
	return Array.from({ length: Math.max(accessoryLimit.value, on.length) }, (_, i) => on[i] ?? null);
});
const levelOk = (p: EquipmentPiece) => !p.minLevel || (current.value?.level ?? 0) >= p.minLevel;
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
	if (confirm(game.t('Dismantle this piece?'))) await game.command('equipment.smelt', { piece: p.id });
}
</script>

<template>
	<section v-if="bag" class="card">
		<h2>{{ game.t('Equipment') }}</h2>
		<select v-if="list.length" v-model="hero" class="pick">
			<option v-for="h in list" :key="h.id" :value="h.id">{{ heroes.name(h as HeroInfo) }}</option>
		</select>
		<ul v-if="current" class="slots">
			<li v-for="s in regularSlots" :key="s.id">
				<small class="muted">{{ game.t(s.name) }}</small>
				<template v-if="worn.get(s.id)">
					<span :class="`rarity rarity-${worn.get(s.id)!.rarity}`">{{ worn.get(s.id)!.icon }} {{ game.t(worn.get(s.id)!.name) }}</span>
					<small>{{ stats(worn.get(s.id)!) }}</small>
					<button type="button" class="link" @click="off(worn.get(s.id)!)">{{ game.t('Take off') }}</button>
				</template>
				<small v-else class="muted">—</small>
			</li>
		</ul>
		<template v-if="current && accessories.length">
			<small class="muted">{{ game.t('Accessories ({n})', { n: accessoryLimit }) }}</small>
			<div class="acc-row" :style="{ gridTemplateColumns: `repeat(${accessories.length}, minmax(0, 1fr))` }">
				<button
					v-for="(a, i) in accessories"
					:key="i"
					type="button"
					class="acc"
					:class="a ? `rarity-${a.rarity}` : 'empty'"
					:title="a ? `${game.t(a.name)} · ${stats(a)}` : game.t('Empty: wear one from the storage below')"
					:disabled="!a"
					@click="a && off(a)"
				>
					{{ a ? a.icon : '＋' }}
				</button>
			</div>
		</template>
		<h3>{{ game.t('Stored here {n} / {cap}', { n: room?.used ?? 0, cap: room?.capacity ?? 0 }) }}</h3>
		<p v-if="!loose.length" class="muted">{{ game.t('Nothing stored here. Equipment drops in realms; an armory stores more.') }}</p>
		<ul class="bag">
			<li v-for="p in loose" :key="p.id">
				<div>
					<strong :class="`rarity rarity-${p.rarity}`">{{ p.icon }} {{ game.t(p.name) }}</strong>
					<small class="muted">
						· {{ game.t(meta?.slots.find((s) => s.id === p.slot)?.name ?? p.slot) }} · <template v-if="p.set">{{ game.t(p.set) }}</template
						><template v-if="p.minLevel">
							· <span :class="{ short: !levelOk(p) }">{{ game.t('Lv {n}', { n: p.minLevel }) }}</span></template
						></small
					>
				</div>
				<small>{{ stats(p) }}</small>
				<div class="row">
					<button v-if="current" type="button" class="small" :disabled="!levelOk(p)" @click="wear(p)">{{ game.t('Wear') }}</button>
					<button type="button" class="small secondary" @click="smelt(p)">
						{{ game.t('Dismantle ({value})', { value: smeltText(p) }) }}
					</button>
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

.acc-row {
	display: grid;
	gap: 4px;
	max-width: 480px;
}

.acc {
	aspect-ratio: 1;
	padding: 0;
	font-size: 1.2em;
	background: var(--input-bg);
	border: 1px solid var(--border);
	border-radius: var(--radius);
}

.acc.empty {
	color: var(--muted);
	border-style: dashed;
}

.short {
	color: var(--danger);
}
</style>
