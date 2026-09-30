<script setup lang="ts">
import { computed } from 'vue';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

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
				<div v-if="a.report" class="report" :class="a.report.outcome">
					<strong>{{ game.t(a.report.outcome) }}</strong>
					· {{ game.t(a.report.target.name ?? a.report.target.kind) }}
					<template v-if="a.report.target.ownerName">({{ a.report.target.ownerName }})</template>
					<small v-if="a.report.note" class="muted"> · {{ game.t(a.report.note) }}</small>
					<small v-if="a.report.outcome !== 'no-battle'" class="muted">
						· {{ game.t('attack {a} vs defence {d}', { a: formatNumber(a.report.attack), d: formatNumber(a.report.defense) }) }}
					</small>
					<div v-if="a.report.attackFactors?.length">
						<small class="muted">
							<span v-for="f in a.report.attackFactors" :key="f.source" class="part"
								>{{ game.t(f.source) }} ×{{ formatNumber(f.factor, { decimals: 2 }) }}</span
							>
						</small>
					</div>
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

.part + .part {
	margin-left: 6px;
}
</style>
