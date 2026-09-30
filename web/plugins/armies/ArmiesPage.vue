<script setup lang="ts">
import { computed } from 'vue';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';
import BattleLanes from './BattleLanes.vue';

const game = useGame();
const settlement = game.use('settlement');
const armies = computed(() => game.view('armies.list') ?? []);
const incoming = computed(() => game.view('armies.incoming') ?? []);
const defenses = computed(() => game.view('pvp.defenses') ?? []);
const unitNames = new Map((game.meta.units ?? []).map((u) => [u.id, u.name]));
const icons = new Map((game.meta.resources ?? []).map((r) => [r.id, r.icon ?? r.id]));
const from = (id: string) => game.t(settlement.list.value.find((s) => s.id === id)?.name ?? id);
const units = (u: Record<string, number>) =>
	Object.entries(u)
		.filter(([, n]) => n > 0)
		.map(([id, n]) => `${game.t(unitNames.get(id) ?? id)} ×${formatNumber(n)}`)
		.join('，');
const promoted = (list: { from: string; to: string; count: number }[]) =>
	list
		.map((p) => `${game.t(unitNames.get(p.from) ?? p.from)} → ${game.t(unitNames.get(p.to) ?? p.to)} ×${formatNumber(p.count)}`)
		.join('，');
async function recall(id: string) {
	if (confirm(game.t('Turn this army back? The unused provisions come back with it.'))) await game.command('armies.recall', { id });
}
const duration = (ms: number) => {
	const s = Math.max(0, Math.ceil(ms / 1000));
	return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};
</script>

<template>
	<section v-if="incoming.length" class="card alert">
		<h2>⚠️ {{ game.t('Incoming attacks') }}</h2>
		<ul class="plain">
			<li v-for="a in incoming" :key="a.id">
				{{
					game.t('{name} attacks {target} in {t}', {
						name: a.attackerName ?? game.t('Someone'),
						target: from(a.settlement),
						t: duration(a.arrivesAt - game.serverNow()),
					})
				}}
			</li>
		</ul>
	</section>
	<section class="card">
		<h2>{{ game.t('Armies') }}</h2>
		<p v-if="!armies.length" class="muted">{{ game.t('No armies away from home. Pick a tile on the map to send troops.') }}</p>
		<ul class="armies">
			<li v-for="a in armies" :key="a.id">
				<div class="head">
					<strong>{{ from(a.from) }} → ({{ a.target.x }}, {{ a.target.y }})</strong>
					<span class="badge">{{ game.t(a.phase) }}</span>
				</div>
				<small>{{ units(a.units) || '—' }}</small>
				<small class="muted">
					{{
						a.phase === 'outbound'
							? game.t('Arrives in {t}', { t: duration(a.arrivesAt - game.serverNow()) })
							: game.t('Back home in {t}', { t: duration(a.returnsAt - game.serverNow()) })
					}}
				</small>
				<small v-if="a.phase === 'returning' && !a.report && Object.keys(a.loot).length" class="muted">
					{{ game.t('Bringing back provisions') }}:
					<span v-for="(n, r) in a.loot" :key="r" class="part">{{ icons.get(String(r)) }}{{ formatNumber(n, { decimals: 1 }) }}</span>
				</small>
				<small v-else-if="a.phase === 'outbound' && Object.keys(a.provisions).length" class="muted">
					{{ game.t('Provisions') }}:
					<span v-for="(n, r) in a.provisions" :key="r" class="part">{{ icons.get(String(r)) }}{{ formatNumber(n, { decimals: 1 }) }}</span>
				</small>
				<button v-if="a.phase === 'outbound'" type="button" class="small secondary recall" @click="recall(a.id)">
					{{ game.t('Recall') }}
				</button>
				<div v-if="a.report" class="report" :class="a.report.outcome">
					<strong>{{ game.t(a.report.outcome) }}</strong>
					· {{ game.t(a.report.target.name ?? a.report.target.kind) }}
					<template v-if="a.report.target.ownerName">({{ a.report.target.ownerName }})</template>
					<small v-if="a.report.note" class="muted"> · {{ game.t(a.report.note) }}</small>
					<small v-if="a.report.outcome !== 'no-battle'" class="muted">
						· {{ game.t('attack {a} vs defence {d}', { a: formatNumber(a.report.attack), d: formatNumber(a.report.defense) }) }}
					</small>
					<details v-if="a.report.battle">
						<summary>
							<small>{{ game.t('grade:' + a.report.battle.grade.attacker) }} · {{ game.t('Lane by lane') }}</small>
						</summary>
						<BattleLanes :detail="a.report.battle" side="attacker" />
					</details>
					<div v-if="units(a.report.losses.attacker)">
						<small>{{ game.t('Losses') }}：{{ units(a.report.losses.attacker) }}</small>
					</div>
					<div v-if="units(a.report.losses.defender)">
						<small>{{ game.t('Enemy losses') }}：{{ units(a.report.losses.defender) }}</small>
					</div>
					<div v-if="Object.keys(a.report.loot).length">
						<small>
							{{ game.t('Loot') }}：<span v-for="(n, r) in a.report.loot" :key="r" class="part"
								>{{ icons.get(String(r)) }}{{ formatNumber(n) }}</span
							>
						</small>
					</div>
					<div v-if="units(a.report.captured)">
						<small>{{ game.t('Captured') }}：{{ units(a.report.captured) }}</small>
					</div>
					<div v-if="a.report.promoted?.attacker.length">
						<small>{{ game.t('Promoted') }}：{{ promoted(a.report.promoted.attacker) }}</small>
					</div>
				</div>
			</li>
		</ul>
	</section>
	<section v-if="defenses.length" class="card">
		<h2>{{ game.t('Defence reports') }}</h2>
		<ul class="plain">
			<li v-for="d in defenses" :key="d.id" class="report" :class="d.report.outcome === 'victory' ? 'defeat' : 'victory'">
				<strong>{{ game.t('{name} attacked {target}', { name: d.attackerName ?? game.t('Someone'), target: from(d.settlement) }) }}</strong>
				<small class="muted"> · {{ new Date(d.at).toLocaleString() }}</small>
				<div>
					<small>{{ game.t(d.report.outcome === 'victory' ? 'The attackers won' : 'The attack was repelled') }}</small>
				</div>
				<div v-if="units(d.report.losses.defender)">
					<small>{{ game.t('Lost') }}：{{ units(d.report.losses.defender) }}</small>
				</div>
				<div v-if="d.report.promoted?.defender.length">
					<small>{{ game.t('Promoted') }}：{{ promoted(d.report.promoted.defender) }}</small>
				</div>
				<details v-if="d.report.battle">
					<summary>
						<small>{{ game.t('grade:' + d.report.battle.grade.defender) }} · {{ game.t('Lane by lane') }}</small>
					</summary>
					<BattleLanes :detail="d.report.battle" side="defender" />
				</details>
				<div v-if="Object.keys(d.report.loot).length">
					<small
						>{{ game.t('Taken') }}：<span v-for="(n, r) in d.report.loot" :key="r" class="part"
							>{{ icons.get(String(r)) }}{{ formatNumber(n) }}</span
						></small
					>
				</div>
			</li>
		</ul>
	</section>
</template>

<style scoped>
.armies {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 10px;
}

.armies li {
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 10px;
	display: grid;
	gap: 4px;
}

.head {
	display: flex;
	gap: 8px;
	align-items: baseline;
}

.alert {
	border-color: var(--danger);
}

.plain {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 8px;
}

.report {
	border-left: 3px solid var(--border);
	padding-left: 8px;
	margin-top: 4px;
}

.report.victory {
	border-color: var(--info);
}

.report.defeat {
	border-color: var(--danger);
}

.recall {
	align-self: flex-start;
	justify-self: start;
}

.part + .part {
	margin-left: 6px;
}
</style>
