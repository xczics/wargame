<script setup lang="ts">
// Buttons for items that asked to show up here (a building entry or a page, `shortcuts` in the
// item's definition). Owned: open its use form (which asks to confirm). Not owned: say where to get it.
import { computed, ref } from 'vue';
import type { Entry } from '../../core/game';
import { useGame } from '../../core/game';

const props = defineProps<{ entry?: Entry }>();
const game = useGame();
const { Outlet } = game.use('forms');
const place = computed(() => (props.entry ? `building:${props.entry.type}` : `page:${game.currentPage.value}`));
const here = computed(() => (game.meta.items ?? []).filter((i) => i.usable && i.shortcuts.includes(place.value)));
const owned = computed(() => new Map((game.view('items.inventory') ?? []).map((i) => [i.id, i.count])));
const open = ref<string | null>(null);
const context = computed(() => (props.entry?.data?.settlement ? { settlement: String(props.entry.data.settlement) } : {}));
</script>

<template>
	<section v-if="here.length" class="card shortcuts">
		<div v-for="i in here" :key="i.id" class="item">
			<button type="button" class="small secondary" @click="open = open === i.id ? null : i.id">
				{{ i.icon }} {{ game.t(i.name) }} <small>×{{ owned.get(i.id) ?? 0 }}</small>
			</button>
			<template v-if="open === i.id">
				<small class="muted">{{ game.t(i.description ?? '') }}</small>
				<component :is="Outlet" v-if="owned.get(i.id)" placement="items" :context="context" :only="[`items.use.${i.id}`]" />
				<div v-else class="none">
					<small>{{ game.t('You have none.') }}</small>
					<small v-if="i.sources.includes('realms')" class="muted">{{ game.t('It can be found on realm adventures.') }}</small>
					<button v-if="i.sources.includes('shop')" type="button" class="small" @click="game.showPage('shop')">
						{{ game.t('Buy it in the shop') }}
					</button>
				</div>
			</template>
		</div>
	</section>
</template>

<style scoped>
.shortcuts,
.item,
.none {
	display: grid;
	gap: 6px;
	justify-items: start;
}
</style>
