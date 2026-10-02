<script setup lang="ts">
// What a hero gives in each role: governing, the institute, leading an army, defending.
import { computed } from 'vue';
import type { HeroInfo } from '../../../src/shared/api';
import { formatNumber } from '../../core/format';
import { useGame } from '../../core/game';

const props = defineProps<{ hero: HeroInfo }>();
const game = useGame();
// Leading an army and defending give the same: shown once, as "military".
const roles = computed(() => {
	const all = { ...(game.view('starter-heroes.roles')?.[props.hero.id] ?? {}) };
	if (all.command && JSON.stringify(all.command) === JSON.stringify(all.defend)) {
		all.military = all.command;
		delete all.command;
		delete all.defend;
	}
	return Object.entries(all).filter(([, list]) => list.length);
});
const roleName: Record<string, string> = {
	governor: 'Governor',
	scholar: 'Institute post',
	command: 'Leading an army',
	defend: 'Defending',
	military: 'Military bonus',
};
// Time and losses go down; the rest up.
const down = new Set(['construction', 'training', 'upkeep', 'research', 'casualty']);
const text = (e: { effect: string; percent: number }) =>
	`${game.t(`effect:${e.effect}`)} ${down.has(e.effect) ? '−' : '+'}${formatNumber(e.percent, { decimals: 1 })}%`;
</script>

<template>
	<dl v-if="roles.length" class="roles">
		<template v-for="[role, list] in roles" :key="role">
			<dt>{{ game.t(roleName[role] ?? role) }}</dt>
			<dd>{{ list.map(text).join(' · ') }}</dd>
		</template>
	</dl>
</template>

<style scoped>
.roles {
	display: grid;
	grid-template-columns: auto 1fr;
	gap: 2px 8px;
	margin: 0;
	font-size: 0.85em;
}

.roles dt {
	color: var(--muted);
}

.roles dd {
	margin: 0;
}
</style>
