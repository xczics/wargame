<script setup lang="ts">
// The language of the game (user 2026-11-04: "语言选择框实装吧。装在底栏"): every language the texts come in, each
// named in itself. On the bottom band, and in a corner of the login screens (before there is a band).
import { computed, inject } from 'vue';
import { GameKey } from './game';

const game = inject(GameKey)!;
// Each language's own name for itself ("简体中文", "English"); worked out once per list.
const options = computed(() => {
	const ids = game.locales();
	return ids.map((id) => {
		let name = id;
		try {
			name = new Intl.DisplayNames([id], { type: 'language' }).of(id) ?? id;
		} catch {
			/* an unknown tag: its id */
		}
		return { id, name };
	});
});
</script>

<template>
	<select
		v-if="options.length > 1"
		class="locale"
		:value="game.locale.value"
		:aria-label="game.t('Language')"
		@change="game.setLocale(($event.target as HTMLSelectElement).value)"
	>
		<option v-for="o in options" :key="o.id" :value="o.id">{{ o.name }}</option>
	</select>
</template>

<style scoped>
.locale {
	width: auto;
	padding: 2px 6px;
	font-size: 0.85em;
}
</style>
