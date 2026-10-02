<script setup lang="ts">
import { pluginName as nameOf } from './names';
import { errorText } from '../../core/api';
import { computed, ref, shallowRef, watch } from 'vue';
import type { ClientState, ResolvedForm, SettlementSummary, User } from '../../../src/shared/api';
import { formatNumber, formatTime } from '../../core/format';
import { useGame } from '../../core/game';
import { useResource } from './useResource';

const game = useGame('gm-panel');
const { Form } = game.use('forms');
const pluginName = (id: string) => nameOf(game, id);
const { data: players, error } = useResource<User[]>(() => '/api/gm/players');
const playerId = ref('');
const forms = shallowRef<ResolvedForm[]>([]);
const summary = shallowRef<ClientState | null>(null);
const player = computed(() => players.value?.find((p) => p.id === playerId.value) ?? null);
const groups = computed(() => {
	const out = new Map<string, ResolvedForm[]>();
	for (const f of forms.value) out.set(f.owner, [...(out.get(f.owner) ?? []), f]);
	return [...out.entries()];
});
// Second-level menu: one plugin at a time.
const activePlugin = ref('');
const activeForms = computed(() => groups.value.find(([owner]) => owner === activePlugin.value)?.[1] ?? []);
watch(groups, (g) => {
	if (!g.some(([owner]) => owner === activePlugin.value)) activePlugin.value = g[0]?.[0] ?? '';
});
const settlements = computed(() => (summary.value?.views['settlements.mine'] ?? []) as SettlementSummary[]);
const pool = computed(() => summary.value?.views['resources.pool'] as { amounts: Record<string, number> } | null | undefined);
const icons = new Map((game.meta.resources ?? []).map((r) => [r.id, r.icon ?? r.id]));

watch(players, (list) => (playerId.value ||= list?.[0]?.id ?? ''));

async function load() {
	if (!playerId.value) return;
	const id = encodeURIComponent(playerId.value);
	[forms.value, summary.value] = await Promise.all([
		game.request<ResolvedForm[]>(`/api/gm/forms?player=${id}`),
		game.request<ClientState>(`/api/gm/players/${id}/state?views=settlements.mine,resources.pool`),
	]);
}
watch(playerId, load);

// "Play as": this browser becomes the player's; the GM session ends (log out and in again to come back).
async function playAs() {
	const p = player.value;
	if (!p || !confirm(game.t('Play as {name}? You leave the GM account: to come back, log out and log in as the GM.', { name: p.username })))
		return;
	try {
		await game.request(`/api/gm/players/${encodeURIComponent(p.id)}/play`, { method: 'POST' });
		location.assign('/');
	} catch (err) {
		game.toast(errorText(err));
	}
}

async function run(command: string, payload: Record<string, unknown>) {
	try {
		await game.request(`/api/gm/players/${encodeURIComponent(playerId.value)}/command`, {
			method: 'POST',
			body: { type: command, payload },
		});
		await load();
		if (playerId.value === game.use('auth').user.id) await game.refresh();
		return true;
	} catch (err) {
		game.toast(errorText(err));
		return false;
	}
}
</script>

<template>
	<p v-if="error" class="error">{{ game.t(error) }}</p>
	<template v-else-if="players">
		<label class="pick">
			{{ game.t('Player') }}
			<select v-model="playerId">
				<option v-for="p in players" :key="p.id" :value="p.id">
					{{ p.username }}{{ p.gm ? ' (GM)' : '' }} · {{ formatTime(p.createdAt) }}
				</option>
			</select>
			<button v-if="player && !player.gm" type="button" class="small secondary" @click="playAs">{{ game.t('Play as this player') }}</button>
		</label>
		<div v-if="player && summary" class="summary">
			<span v-for="s in settlements" :key="s.id" class="chip">{{ game.t(s.name) }} ({{ s.x }}, {{ s.y }})</span>
			<span v-if="pool" class="muted">
				{{ game.t('Capital') }}:
				<span v-for="(n, r) in pool.amounts" :key="r" class="part">{{ icons.get(String(r)) }}{{ formatNumber(n) }}</span>
			</span>
		</div>
		<div v-if="groups.length" class="split">
			<nav class="plugins">
				<button
					v-for="[owner, list] in groups"
					:key="owner"
					type="button"
					:class="{ active: owner === activePlugin }"
					@click="activePlugin = owner"
				>
					{{ pluginName(owner) }} <small>{{ list.length }}</small>
				</button>
			</nav>
			<div class="forms">
				<component :is="Form" v-for="f in activeForms" :key="f.command" :form="f" :submit="run" />
			</div>
		</div>
	</template>
</template>

<style scoped>
.pick {
	max-width: 420px;
}

.summary {
	display: flex;
	flex-wrap: wrap;
	gap: 6px 12px;
	align-items: baseline;
	margin: 8px 0 4px;
}

.chip {
	background: var(--input-bg);
	border: 1px solid var(--border);
	border-radius: 999px;
	padding: 2px 10px;
	font-size: 0.85em;
}

.part + .part {
	margin-left: 6px;
}

.split {
	display: grid;
	grid-template-columns: 160px 1fr;
	gap: 16px;
	margin-top: 12px;
	align-items: start;
}

.plugins {
	display: grid;
	gap: 4px;
}

.plugins button {
	background: none;
	color: var(--text);
	text-align: left;
	border-radius: 8px;
	padding: 8px 10px;
	display: flex;
	justify-content: space-between;
}

.plugins button.active {
	background: var(--input-bg);
	box-shadow: inset 3px 0 0 var(--accent);
}

@media (max-width: 640px) {
	.split {
		grid-template-columns: 1fr;
	}

	.plugins {
		display: flex;
		flex-wrap: wrap;
	}
}

.forms {
	display: grid;
	grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
	gap: 12px;
	align-items: start;
}
</style>
