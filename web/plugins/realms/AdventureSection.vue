<script setup lang="ts">
// On hero cards: the hero's adventure numbers (equipment and research included).
import { computed } from 'vue';
import type { HeroInfo } from '../../../src/shared/api';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

const props = defineProps<{ hero: HeroInfo }>();
const game = useGame();
const s = computed(() => game.view('realms.overview')?.heroStats[props.hero.id]);
</script>

<template>
	<small v-if="s" class="adv">
		{{ game.t('Adventure') }}：{{
			game.t('Attack {a} · Defence {d} · HP {h} · Recovery {r}%', {
				a: formatNumber(s.attack),
				d: formatNumber(s.defense),
				h: formatNumber(s.hp),
				r: formatNumber(s.recovery, { decimals: 1 }),
			})
		}}<template v-if="s.luck"> · {{ game.t('Luck +{l}%', { l: formatNumber(s.luck, { decimals: 1 }) }) }}</template>
	</small>
</template>

<style scoped>
.adv {
	color: var(--muted);
}
</style>
