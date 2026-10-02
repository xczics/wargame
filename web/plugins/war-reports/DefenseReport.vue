<script setup lang="ts">
// Report of an attack on one of the player's settlements.
import { computed } from 'vue';
import type { DefenseMail, MailMessage } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import BattleLanes from './BattleLanes.vue';
import { reportText } from './format';

const props = defineProps<{ message: MailMessage }>();
const game = useGame();
const text = reportText(game);
const d = computed(() => props.message.data as DefenseMail);
const r = computed(() => d.value.report);
// The report's outcome is the attacker's.
const held = computed(() => r.value.outcome !== 'victory');
// Non-players (bandits) are named by a content key: translate it.
const attacker = computed(() => {
	const name = d.value.attackerName ? game.t(d.value.attackerName) : game.t('Someone');
	return r.value.attacker?.level ? game.t('{name} (Lv {n})', { name, n: r.value.attacker.level }) : name;
});
const signed = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(n % 1 ? 2 : 0)}`;
</script>

<template>
	<div class="report" :class="held ? 'victory' : 'defeat'">
		<p>
			<strong>{{ game.t(held ? 'The attack was repelled' : 'The attackers won') }}</strong>
			· {{ text.settlementName(d.settlement) }} ← {{ attacker }}
		</p>
		<dl>
			<template v-if="text.units(r.losses.defender)">
				<dt>{{ game.t('Lost') }}</dt>
				<dd>{{ text.units(r.losses.defender) }}</dd>
			</template>
			<template v-if="text.units(r.losses.attacker)">
				<dt>{{ game.t('Enemy losses') }}</dt>
				<dd>{{ text.units(r.losses.attacker) }}</dd>
			</template>
			<template v-if="text.amounts(r.loot)">
				<dt>{{ game.t('Taken') }}</dt>
				<dd>{{ text.amounts(r.loot) }}</dd>
			</template>
			<template v-if="r.prestige">
				<dt>{{ game.t('Prestige') }}</dt>
				<dd :class="r.prestige > 0 ? 'up' : 'down'">{{ signed(r.prestige) }}</dd>
			</template>
			<template v-if="r.rewards?.length">
				<dt>{{ game.t('Found') }}</dt>
				<dd>
					<template v-for="(l, k) in r.rewards" :key="k"
						>{{ k ? '、' : '' }}{{ l.icon ?? '' }}<span :class="l.rarity ? `rarity rarity-${l.rarity}` : ''">{{ game.t(l.name) }}</span
						>{{ l.count && l.count > 1 ? ` ×${l.count}` : '' }}</template
					>
				</dd>
			</template>
			<template v-if="r.promoted?.defender.length">
				<dt>{{ game.t('Promoted') }}</dt>
				<dd>{{ text.promoted(r.promoted.defender) }}</dd>
			</template>
		</dl>
		<details v-if="r.battle" open>
			<summary>
				<small>{{ game.t('Lane by lane') }}</small>
			</summary>
			<BattleLanes :detail="r.battle" side="defender" />
		</details>
	</div>
</template>

<style scoped src="./report.css"></style>
