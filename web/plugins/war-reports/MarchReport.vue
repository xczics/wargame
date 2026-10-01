<script setup lang="ts">
// Report of one of the player's marches: what it met, what it cost, what it brought.
import { computed } from 'vue';
import type { MailMessage, MarchMail } from '../../../src/shared/api';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';
import BattleLanes from './BattleLanes.vue';
import { reportText } from './format';

const props = defineProps<{ message: MailMessage }>();
const game = useGame();
const text = reportText(game);
const m = computed(() => props.message.data as MarchMail);
const r = computed(() => m.value.report);
</script>

<template>
	<div class="report" :class="r.outcome">
		<p>
			<span class="badge">{{ game.t('mission:' + m.mission) }}</span>
			{{ text.settlementName(m.from) }} → ({{ m.target.x }}, {{ m.target.y }}) · {{ game.t(r.target.name ?? r.target.kind) }}
			<template v-if="r.target.ownerName">（{{ r.target.ownerName }}）</template>
		</p>
		<p>
			{{
				[
					r.outcome !== 'no-battle' || m.mission === 'attack' ? game.t(r.outcome) : '',
					r.note ? game.t(r.note) : '',
					r.outcome !== 'no-battle' ? game.t('attack {a} vs defence {d}', { a: formatNumber(r.attack), d: formatNumber(r.defense) }) : '',
				]
					.filter(Boolean)
					.join(' · ')
			}}
		</p>
		<dl>
			<dt>{{ game.t('Troops') }}</dt>
			<dd>{{ text.units(m.units) || '—' }}</dd>
			<template v-if="text.amounts(m.cargo ?? {})">
				<dt>{{ game.t(m.deliverTo ? 'Supplies delivered' : 'Supplies brought back') }}</dt>
				<dd>{{ text.amounts(m.cargo) }}</dd>
			</template>
			<template v-if="text.units(r.losses.attacker)">
				<dt>{{ game.t('Losses') }}</dt>
				<dd>{{ text.units(r.losses.attacker) }}</dd>
			</template>
			<template v-if="text.units(r.losses.defender)">
				<dt>{{ game.t('Enemy losses') }}</dt>
				<dd>{{ text.units(r.losses.defender) }}</dd>
			</template>
			<template v-if="text.amounts(r.loot)">
				<dt>{{ game.t(m.mission === 'transport' ? 'Brought back' : 'Loot') }}</dt>
				<dd>{{ text.amounts(r.loot) }}</dd>
			</template>
			<template v-if="text.units(r.captured)">
				<dt>{{ game.t('Captured') }}</dt>
				<dd>{{ text.units(r.captured) }}</dd>
			</template>
			<template v-if="r.promoted?.attacker.length">
				<dt>{{ game.t('Promoted') }}</dt>
				<dd>{{ text.promoted(r.promoted.attacker) }}</dd>
			</template>
		</dl>
		<details v-if="r.battle" open>
			<summary>
				<small>{{ game.t('Lane by lane') }}</small>
			</summary>
			<BattleLanes :detail="r.battle" side="attacker" />
		</details>
	</div>
</template>

<style scoped src="./report.css"></style>
