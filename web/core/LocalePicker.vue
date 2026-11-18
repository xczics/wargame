<script setup lang="ts">
// The language of the game (user 2026-11-04: "语言选择框实装吧。装在底栏"): every language the texts come in, each
// named in itself. In the user menu (with the password and logging out), and in a corner of the login screens.
import { computed, inject } from 'vue';
import { GameKey } from './game';

const game = inject(GameKey)!;
// Each language's own name for itself, as short as tells them apart: "中文", "English" (the region only when two share a
// language; user 2026-11-18: on a phone it took too much of the band for something seldom used). Once per list.
const options = computed(() => {
	const ids = game.locales();
	const base = (id: string) => id.split('-')[0];
	const named = (id: string, tag: string) => {
		try {
			return new Intl.DisplayNames([id], { type: 'language' }).of(tag) ?? id;
		} catch {
			return id; // an unknown tag: its id
		}
	};
	return ids.map((id) => ({ id, name: named(id, ids.filter((x) => base(x) === base(id)).length > 1 ? id : base(id)) }));
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
