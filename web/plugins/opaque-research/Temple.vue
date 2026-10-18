<script setup lang="ts">
// The Shuangqing Temple (docs/design/gameplay.md §14.3, ui.md): the heroes' applications with their reviews, to approve
// or turn down, and the projects under way. What changes comes from the view; the sentences, code names and bonus
// names from the static texts (fetched once), put together here.
import { computed, ref, watchEffect } from 'vue';
import type { OpaqueApplication, OpaqueStatus, OpaqueTexts } from '../../../src/shared/api';
import { amounts, duration } from '../../../src/shared/format';
import { useGame } from '../../core/game';
import { formatTime } from '../../core/format';
import { groupName, pick, placeholders, reviewer, SECTIONS } from './texts';

const props = defineProps<{ view?: string; texts?: string }>();
const game = useGame('opaque-research');
const status = computed(() => game.view('opaque-research.status') as OpaqueStatus | null);
const texts = computed(() => game.static<OpaqueTexts>(props.texts ?? 'opaque-research.texts'));
const icons = computed(() => Object.fromEntries((game.meta.resources ?? []).map((r) => [r.id, r.icon ?? r.id])));
const open = ref<string | null>(null);
const tierName = (tier: number) => game.t(`tier:${tier}`);

const t = (key: string, vars?: Record<string, string | number>) => game.t(key, vars);
const fill = (a: OpaqueApplication, key: string) => (texts.value ? t(key, placeholders(a, texts.value, t, tierName(a.tier))) : '');
const paragraphs = (a: OpaqueApplication) =>
	texts.value ? SECTIONS.map((s) => ({ section: s, lines: pick(a, texts.value!, s, s === 'method' ? 2 : 1).map((k) => fill(a, k)) })) : [];
const review = (a: OpaqueApplication) => (texts.value ? pick(a, texts.value, 'review', 2).map((k) => fill(a, k)) : []);

watchEffect(() => {
	for (const p of status.value?.projects ?? []) game.refreshAt(p.endsAt);
});
const full = computed(() => !!status.value && status.value.running >= status.value.max);
const approve = (a: OpaqueApplication) =>
	game.command('opaque-research.approve', { hero: a.hero, season: a.season, version: a.version }, { pending: 'Approving…' });
const reject = (a: OpaqueApplication) =>
	game.command('opaque-research.reject', { hero: a.hero, season: a.season }, { pending: 'Turning down…' });
</script>

<template>
	<section class="card temple">
		<h3>☯️ {{ game.t('Research applications') }}</h3>
		<p v-if="!status || !status.unlocked" class="muted">{{ game.t('Nothing to approve yet.') }}</p>
		<template v-else>
			<p class="muted">
				{{ game.t('Up to {tier} · projects {n} / {max}', { tier: tierName(status.unlocked), n: status.running, max: status.max }) }}
			</p>
			<p v-if="!status.applications.length" class="muted">{{ game.t('No applications: heroes posted at an institute write them.') }}</p>
			<ul class="apps">
				<li v-for="a in status.applications" :key="a.hero">
					<button type="button" class="head" @click="open = open === a.hero ? null : a.hero">
						<b>{{ game.t(a.heroName) }}</b>
						<span>{{ tierName(a.tier) }}</span>
						<span
							>{{ amounts(a.cost, icons) }}<template v-if="a.yuanbao"> · 💰{{ a.yuanbao }}</template></span
						>
						<span>⏳{{ duration(a.seconds) }}</span>
						<span>{{ game.t('Rate {rate}', { rate: `${Math.round(a.rate * 100)}%` }) }}</span>
					</button>
					<div v-if="open === a.hero" class="body">
						<div v-for="p in paragraphs(a)" :key="p.section">
							<h4>{{ game.t(`section:${p.section}`) }}</h4>
							<p v-for="(l, i) in p.lines" :key="i">{{ l }}</p>
						</div>
						<div class="review">
							<h4>{{ game.t('Review') }} · {{ texts ? game.t(reviewer(a, texts)) : '' }}</h4>
							<p v-for="(l, i) in review(a)" :key="i">{{ l }}</p>
							<p>
								<b>{{ game.t('Rate {rate}', { rate: `${Math.round(a.rate * 100)}%` }) }}</b>
							</p>
						</div>
						<div class="actions">
							<button type="button" :disabled="full" @click="approve(a)">{{ game.t('Approve') }}</button>
							<button type="button" class="secondary" @click="reject(a)">{{ game.t('Turn down') }}</button>
							<span v-if="full" class="muted">{{ game.t('As many projects as the temple allows are under way.') }}</span>
						</div>
					</div>
				</li>
			</ul>
			<template v-if="status.projects.length">
				<h4>{{ game.t('Under way') }}</h4>
				<ul class="projects">
					<li v-for="p in status.projects" :key="p.hero">
						{{ game.t(p.heroName) }} · {{ tierName(p.tier) }} · {{ texts ? groupName(p.group, texts, t) : '' }} ·
						{{ game.t('ends {at}', { at: formatTime(p.endsAt) }) }}
					</li>
				</ul>
			</template>
		</template>
	</section>
</template>

<style scoped>
.temple {
	display: grid;
	gap: 8px;
}

.apps,
.projects {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 6px;
}

.head {
	display: flex;
	flex-wrap: wrap;
	gap: 4px 12px;
	width: 100%;
	text-align: left;
	background: var(--surface-2);
	color: var(--text);
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 6px 10px;
}

.body {
	padding: 6px 10px;
	border-left: 3px solid var(--border);
}

.body h4 {
	margin: 8px 0 2px;
}

.body p {
	margin: 2px 0;
}

.review {
	margin-top: 6px;
	padding-top: 4px;
	border-top: 1px dashed var(--border);
}

.actions {
	display: flex;
	gap: 8px;
	align-items: center;
	margin-top: 8px;
}
</style>
