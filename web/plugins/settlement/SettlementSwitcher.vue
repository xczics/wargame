<script setup lang="ts">
import { useGame } from '../../core/game';

const game = useGame();
const settlement = game.use('settlement');
</script>

<template>
	<label v-if="settlement.list.value.length" class="card switcher">
		<span class="sr-only">{{ game.t('Settlement') }}</span>
		<select :value="settlement.current.value?.id" @change="settlement.select(($event.target as HTMLSelectElement).value)">
			<option v-for="s in settlement.list.value" :key="s.id" :value="s.id">
				{{ game.t(s.name) }} · {{ settlement.kindName(s.kind) }} ({{ s.x }}, {{ s.y }})
			</option>
		</select>
	</label>
</template>

<style scoped>
.switcher {
	display: block;
	padding: 10px 12px;
}

.switcher select {
	width: 100%;
	padding: 6px 10px;
}

.sr-only {
	position: absolute;
	width: 1px;
	height: 1px;
	overflow: hidden;
	clip: rect(0 0 0 0);
}
</style>
