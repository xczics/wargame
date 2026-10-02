<script setup lang="ts">
// Generic widget "ui.sync" (renders nothing; declared in a band so it works on every page): refreshes at
// the given times, or runs the given command then (e.g. commit an army's arrival right away). Commands
// already due when the page loads run once.
import { onBeforeUnmount, watch } from 'vue';
import type { SyncData } from '../../src/shared/ui';
import { useGame } from '../core/game';

const props = defineProps<{ view: string }>();
const game = useGame();
const data = () => (game.state.value?.views[props.view] ?? null) as SyncData | null;
let timer: ReturnType<typeof setTimeout> | undefined;
let loaded = false;

watch(
	() => JSON.stringify(data()?.items ?? []),
	() => {
		const items = data()?.items ?? [];
		const now = game.serverNow();
		const commands = items.filter((i) => i.command);
		if (!loaded && data()) {
			loaded = true;
			const due = commands.find((i) => i.at <= now);
			if (due) void game.command(due.command!, due.payload ?? {});
		}
		const refresh = Math.min(...items.filter((i) => !i.command && i.at > now).map((i) => i.at));
		if (Number.isFinite(refresh)) game.refreshAt(refresh);
		clearTimeout(timer);
		const next = commands.filter((i) => i.at > now).sort((a, b) => a.at - b.at)[0];
		if (next) timer = setTimeout(() => void game.command(next.command!, next.payload ?? {}), next.at - now + 500);
	},
	{ immediate: true },
);
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
	<span hidden></span>
</template>
