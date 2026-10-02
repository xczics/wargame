<script setup lang="ts">
// All realms: locked or open, where they are, their five tasks; pick an idle hero to see how
// far it would get (the same rule the server uses) and send it.
import { computed, ref, watch } from 'vue';
import type { HeroInfo, RealmTaskInfo } from '../../../src/shared/api';
import { fightGroups } from '../../../src/shared/realms';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

const game = useGame();
const heroes = game.use('heroes');
const o = computed(() => game.view('realms.overview'));
const idle = computed(() => (game.view('heroes.list') ?? []).filter((h) => h.duty === 'idle'));
const hero = ref('');
watch(
	idle,
	(list) => {
		if (!list.some((h) => h.id === hero.value)) hero.value = list[0]?.id ?? '';
	},
	{ immediate: true },
);
const stats = computed(() => (hero.value ? o.value?.heroStats[hero.value] : undefined));
const n = (x: number) => formatNumber(x);

/** "drops 55%, 0.7 on average" per group beaten. */
function dropText(t: RealmTaskInfo) {
	const total = t.dropCounts.reduce((a, b) => a + b, 0) || 1;
	const some = 1 - (t.dropCounts[0] ?? 0) / total;
	const mean = t.dropCounts.reduce((a, w, n) => a + w * n, 0) / total;
	return game.t('drops {p}% · {m} on average', { p: Math.round(some * 100), m: formatNumber(mean, { decimals: 1 }) });
}
const strongest = (t: RealmTaskInfo) => ({
	a: n(Math.max(...t.groups.map((g) => g.attack))),
	d: n(Math.max(...t.groups.map((g) => g.defense))),
	h: n(Math.max(...t.groups.map((g) => g.hp))),
});
function preview(t: RealmTaskInfo) {
	if (!stats.value) return '';
	const out = fightGroups(stats.value, t.groups, o.value?.minDamage);
	return out.every((x) => x.won) ? game.t('Expected: clears it') : game.t('Expected: falls at group {n}', { n: out.length });
}
const groups = ['common', 'uncommon', 'rare', 'clear'] as const;
const go = (realm: string, task: number) => game.command('realms.adventure', { hero: hero.value, realm, task });
</script>

<template>
	<section v-if="o" class="card">
		<h2>{{ game.t('Realms') }}</h2>
		<div class="row">
			<label>{{ game.t('Hero') }}</label>
			<select v-if="idle.length" v-model="hero">
				<option v-for="h in idle" :key="h.id" :value="h.id">
					{{ heroes.name(h as HeroInfo) }} ({{ game.t('Lv {n}', { n: h.level }) }})
				</option>
			</select>
			<small v-else class="muted">{{ game.t('No idle hero.') }}</small>
			<small v-if="stats" class="muted"
				>{{
					game.t('Attack {a} · Defence {d} · HP {h} · Recovery {r}%', {
						a: n(stats.attack),
						d: n(stats.defense),
						h: n(stats.hp),
						r: formatNumber(stats.recovery, { decimals: 1 }),
					})
				}}<template v-if="stats.luck"> · {{ game.t('Luck +{l}%', { l: formatNumber(stats.luck, { decimals: 1 }) }) }}</template></small
			>
		</div>
		<div v-for="r in o.realms" :key="r.id" class="realm" :class="{ locked: !r.unlocked }">
			<div class="head">
				<strong>{{ r.order }}. {{ game.t(r.name) }}</strong>
				<span v-if="!r.unlocked" class="badge">🔒 {{ game.t('Locked') }}</span>
				<small v-if="r.sites.length" class="muted">{{
					game.t('On the map: {places}', { places: r.sites.map((s) => `(${s.x}, ${s.y})`).join(' ') })
				}}</small>
			</div>
			<small v-if="r.quote" class="quote">{{ game.t(r.quote) }}</small>
			<small v-if="!r.unlocked" class="muted">{{ game.t('Open it with its key, dropped by the hardest task of the realm before.') }}</small>
			<ul v-else class="tasks">
				<li v-for="t in r.tasks" :key="t.index">
					<strong>{{ t.index + 1 }}. {{ game.t(t.name) }}</strong>
					<small>
						{{ game.t('{n} groups', { n: t.groups.length }) }} · {{ game.t('strongest {a} / {d} / {h}', strongest(t)) }} ·
						{{ game.t('exp {n}', { n: n(t.exp.reduce((a, b) => a + b, 0)) }) }} ·
						{{ dropText(t) }}
					</small>
					<template v-if="t.drops">
						<small v-for="g in groups" v-show="t.drops[g].length" :key="g" class="drops">
							<span class="tag">{{ game.t(`drops:${g}`) }}</span>
							<template v-for="(p, k) in t.drops[g]" :key="k"
								>{{ k ? '、' : ' ' }}{{ p.icon ?? ''
								}}<span :class="p.rarity ? `rarity rarity-${p.rarity}` : ''">{{ game.t(p.name) }}</span></template
							>
						</small>
					</template>
					<small v-else class="muted">{{ game.t('Clear it once to see what it can drop.') }}</small>
					<small v-if="stats" class="preview">{{ preview(t) }}</small>
					<button type="button" class="small" :disabled="!hero" @click="go(r.id, t.index)">{{ game.t('Set out') }}</button>
				</li>
			</ul>
		</div>
	</section>
</template>

<style scoped>
.row {
	display: flex;
	gap: 8px;
	align-items: center;
	flex-wrap: wrap;
	margin-bottom: 8px;
}

.row select {
	width: auto;
}

.realm {
	display: grid;
	gap: 4px;
	padding: 10px 0;
	border-top: 1px solid var(--border);
}

.realm.locked {
	opacity: 0.7;
}

.head {
	display: flex;
	gap: 8px;
	align-items: baseline;
	flex-wrap: wrap;
}

.quote {
	color: var(--muted);
	font-style: italic;
}

.tasks {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
	gap: 8px;
}

.tasks li {
	display: grid;
	gap: 3px;
	padding: 8px;
	border: 1px solid var(--border);
	border-radius: var(--radius);
	align-content: start;
}

.preview {
	color: var(--accent);
}

.drops .tag {
	color: var(--muted);
	font-weight: 600;
}

button {
	justify-self: start;
}
</style>
