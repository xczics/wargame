<script setup lang="ts">
import { computed } from 'vue';
import { useGame } from '../../core/game';
import { selected } from './state';

const game = useGame();
const inbox = computed(() => game.view('mail.inbox'));
const messages = computed(() => inbox.value?.messages ?? []);
const vars = (v: Record<string, string | number>) =>
	Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? game.t(x) : x]));

async function open(id: string, read: boolean) {
	selected.value = id;
	if (!read) await game.command('mail.read', { ids: [id] });
}
</script>

<template>
	<section class="card">
		<div class="head">
			<h2>{{ game.t('Mailbox') }}</h2>
			<button v-if="inbox?.unread" type="button" class="small secondary" @click="game.command('mail.read', { all: true })">
				{{ game.t('Mark all read') }}
			</button>
		</div>
		<p v-if="!messages.length" class="muted">{{ game.t('No mail.') }}</p>
		<ul class="list">
			<li v-for="m in messages" :key="m.id">
				<button type="button" class="item" :class="{ active: m.id === selected, unread: !m.read }" @click="open(m.id, m.read)">
					<span class="title">{{ game.t(m.title, vars(m.vars)) }}</span>
					<small class="muted">{{ new Date(m.at).toLocaleString() }}</small>
				</button>
			</li>
		</ul>
		<p v-if="inbox?.more" class="muted">
			<small>{{ game.t('Older messages are not shown.') }}</small>
		</p>
	</section>
</template>

<style scoped>
.head {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	gap: 8px;
}

.list {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	gap: 4px;
}

.item {
	width: 100%;
	display: grid;
	gap: 2px;
	text-align: left;
	background: none;
	color: inherit;
	border: 1px solid var(--border);
	border-radius: var(--radius);
	padding: 6px 8px;
}

.item.active {
	border-color: var(--accent);
}

.item.unread .title {
	font-weight: 600;
}

.item.unread .title::before {
	content: '● ';
	color: var(--accent);
}
</style>
