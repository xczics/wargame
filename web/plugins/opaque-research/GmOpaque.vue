<script setup lang="ts">
// The GM's opaque research tab (user 2026-10-19: "没找到隐藏维度对应关系的入口"): the ring of groups (the same editor as
// the rules page's, saved through the same rule), and which dimensions — by their code names — each group holds and
// what it gives. Everything shown comes from the static texts the client has; the rule from the GM's config.
import { computed, onActivated, onMounted, ref, shallowRef } from 'vue';
import type { ConfigEntry, OpaqueGroup, OpaqueTexts } from '../../../src/shared/api';
import { errorText } from '../../core/api';
import { useGame } from '../../core/game';
import GmGroups from './GmGroups.vue';

const KEY = 'opaque-research.groups';
const game = useGame('opaque-research');
const texts = computed(() => game.static<OpaqueTexts>('opaque-research.texts'));
const rule = shallowRef<ConfigEntry | null>(null);
const draft = ref<{ count: number; groups: OpaqueGroup[] } | null>(null);
const busy = ref(false);

async function load() {
	try {
		rule.value = (await game.request<ConfigEntry[]>('/api/gm/config')).find((r) => r.key === KEY) ?? null;
		draft.value = rule.value ? structuredClone(rule.value.value as { count: number; groups: OpaqueGroup[] }) : null;
	} catch (err) {
		game.toast(errorText(err));
	}
}
onMounted(load);
onActivated(load);
const dirty = computed(() => !!rule.value && JSON.stringify(draft.value) !== JSON.stringify(rule.value.value));
async function save() {
	busy.value = true;
	try {
		await game.request(`/api/gm/config/${KEY}`, { method: 'PUT', body: { value: draft.value } });
		game.toast(game.t('Saved'), 'info');
		await load();
		await game.refresh();
	} catch (err) {
		game.toast(errorText(err));
	} finally {
		busy.value = false;
	}
}
const undo = () => (draft.value = rule.value ? structuredClone(rule.value.value as { count: number; groups: OpaqueGroup[] }) : null);
async function reset() {
	await game.request(`/api/gm/config/${KEY}`, { method: 'DELETE' });
	await load();
	await game.refresh();
}

// Group i holds dimensions ceil(256 i / n) to ceil(256 (i + 1) / n) - 1, as the server groups them.
const startOf = (i: number, n: number) => Math.floor((i * 256 + n - 1) / n);
const mapping = computed(() => {
	const g = draft.value?.groups ?? [];
	const t = texts.value;
	return g.map((parts, i) => {
		const dims = Array.from({ length: startOf(i + 1, g.length) - startOf(i, g.length) }, (_, k) => startOf(i, g.length) + k);
		return {
			i,
			from: dims[0] + 1,
			to: dims[dims.length - 1] + 1,
			gives: parts.map((p) => `${t?.bonuses[p.bonus] ? game.t(t.bonuses[p.bonus].name) : p.bonus} ${p.step}%`).join(game.t(', ')),
			codes: dims.map((d) => (t?.codes[d] ? game.t(t.codes[d]) : String(d + 1))).join(game.t(', ')),
		};
	});
});
</script>

<template>
	<section class="card gm-opaque">
		<h2>{{ game.t('Opaque research') }}</h2>
		<p class="muted">{{ game.t('The 256 hidden dimensions, in groups round the ring; each group gives what is set for it.') }}</p>
		<template v-if="draft">
			<GmGroups :value="draft" @update="draft = $event" />
			<div class="row">
				<button type="button" class="small" :disabled="!dirty || busy" @click="save">{{ game.t('Save') }}</button>
				<button v-if="dirty" type="button" class="small secondary" @click="undo">
					{{ game.t('Undo') }}
				</button>
				<button v-if="rule?.overridden" type="button" class="small secondary" @click="reset">{{ game.t('Reset to default') }}</button>
			</div>
			<h3>{{ game.t('Dimensions of each group') }}</h3>
			<details v-for="m in mapping" :key="m.i">
				<summary>
					{{ game.t('Segment {n}', { n: m.i + 1 }) }} · {{ game.t('dimensions {from}–{to}', { from: m.from, to: m.to }) }} ·
					{{ m.gives || game.t('Gives nothing yet.') }}
				</summary>
				<p class="codes">{{ m.codes }}</p>
			</details>
		</template>
	</section>
</template>

<style scoped>
.gm-opaque {
	display: grid;
	gap: 8px;
}

.row {
	display: flex;
	gap: 8px;
}

details summary {
	cursor: pointer;
}

.codes {
	margin: 4px 0 8px 16px;
	color: var(--muted);
}
</style>
