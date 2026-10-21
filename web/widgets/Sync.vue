<script setup lang="ts">
// Generic widget "ui.sync" (renders nothing; declared in a band so it works on every page): wakes at the given
// times (`game.refreshAt`: the server's wake command, else a sync), or runs the given command then. A time already
// past (something due and not committed yet, e.g. it fell due while the page was closed) is acted on once, not again
// with every sync that still shows it.
import { onBeforeUnmount, watch } from 'vue';
import type { SyncData } from '../../src/shared/ui';
import { useGame } from '../core/game';

const props = defineProps<{ view: string }>();
const game = useGame('widgets');
const data = () => (game.view(props.view as never) ?? null) as SyncData | null;
let timer: ReturnType<typeof setTimeout> | undefined;
/** Past items acted on, by time and command. */
const done = new Set<string>();

watch(
	() => JSON.stringify(data()?.items ?? []),
	() => {
		const items = data()?.items ?? [];
		const now = game.serverNow();
		for (const i of items.filter((x) => x.at <= now)) {
			const key = `${i.at}|${i.command ?? ''}`;
			if (done.has(key)) continue;
			done.add(key);
			if (i.command) void game.command(i.command, i.payload ?? {});
			else game.refreshAt(i.at);
		}
		const refresh = Math.min(...items.filter((i) => !i.command && i.at > now).map((i) => i.at));
		if (Number.isFinite(refresh)) game.refreshAt(refresh);
		clearTimeout(timer);
		const next = items.filter((i) => i.command && i.at > now).sort((a, b) => a.at - b.at)[0];
		if (next) timer = setTimeout(() => void game.command(next.command!, next.payload ?? {}), next.at - now + 500);
	},
	{ immediate: true },
);
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
	<span hidden></span>
</template>
