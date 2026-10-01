<script setup lang="ts">
// Troops that left or dropped a tier because their upkeep ran out.
import { computed } from 'vue';
import type { MailMessage, ShortageMail } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import { reportText } from './format';

const props = defineProps<{ message: MailMessage }>();
const game = useGame();
const text = reportText(game);
const s = computed(() => props.message.data as ShortageMail);
const resource = computed(() => game.meta.resources?.find((r) => r.id === s.value.resource));
</script>

<template>
	<div class="report defeat">
		<p>
			{{ text.settlementName(s.settlement) }} ·
			{{ game.t('Out of {resource}', { resource: `${resource?.icon ?? ''}${game.t(resource?.name ?? s.resource)}` }) }}
		</p>
		<dl>
			<template v-if="text.units(s.routed)">
				<dt>{{ game.t('Deserted') }}</dt>
				<dd>{{ text.units(s.routed) }}</dd>
			</template>
			<template v-if="s.downgraded.length">
				<dt>{{ game.t('Dropped a tier') }}</dt>
				<dd>{{ text.promoted(s.downgraded) }}</dd>
			</template>
		</dl>
		<p class="muted">
			<small>{{ game.t('Until income covers upkeep again, a little more leaves every round.') }}</small>
		</p>
	</div>
</template>

<style scoped src="./report.css"></style>
