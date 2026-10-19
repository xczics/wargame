<script setup lang="ts">
import { formatTime } from '../../core/format';
import { computed, ref, watch } from 'vue';
import type { ClientState, MailInbox } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import { page, pages, selected } from './state';

const game = useGame('mail');
const inbox = computed(() => game.view('mail.inbox'));
const current = computed(() => (page.value === 0 ? inbox.value : pages.value[page.value - 1]));
const messages = computed(() => current.value?.messages ?? []);
// New mail shifts every older page: fetch them again when needed.
watch(
	() => inbox.value?.messages[0]?.id,
	() => {
		pages.value = [];
		page.value = 0;
	},
);

const loading = ref(false);
async function older() {
	const last = messages.value[messages.value.length - 1];
	if (!last || loading.value) return;
	if (!pages.value[page.value]) {
		loading.value = true;
		try {
			// Only this view: the page's headers (what the messages say comes when one is opened).
			const q = new URLSearchParams({ views: 'mail.inbox', mailBefore: String(last.at), mailBeforeId: last.id });
			const state = await game.request<ClientState>(`/api/state?${q}`);
			const next = state.views['mail.inbox'] as MailInbox;
			pages.value = [...pages.value.slice(0, page.value), { messages: next.messages, more: next.more }];
		} finally {
			loading.value = false;
		}
	}
	page.value++;
}

async function open(id: string, read: boolean) {
	// What it says comes meanwhile (the open message's view fetches it).
	selected.value = id;
	if (read) return;
	await game.command('mail.read', { ids: [id] });
	// Older pages are copies: mark it there too.
	for (const p of pages.value) for (const m of p.messages) if (m.id === id) m.read = true;
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
					<span class="title"
						>{{ game.t(m.title)
						}}<span
							v-if="m.gift"
							class="gift"
							:class="m.gift"
							:title="game.t(m.gift === 'unclaimed' ? 'Attachments to claim' : 'Attachments claimed')"
							>🎁</span
						></span
					>
					<small class="muted">{{ formatTime(m.at) }}</small>
				</button>
			</li>
		</ul>
		<div v-if="page > 0 || current?.more" class="pager">
			<button type="button" class="small secondary" :disabled="page === 0" @click="page--">{{ game.t('Newer') }}</button>
			<small class="muted">{{ game.t('Page {n}', { n: page + 1 }) }}</small>
			<button type="button" class="small secondary" :disabled="!current?.more || loading" @click="older">
				{{ game.t(loading ? 'Loading…' : 'Older') }}
			</button>
		</div>
	</section>
</template>

<style scoped>
.head {
	display: flex;
	justify-content: space-between;
	align-items: baseline;
	gap: 8px;
}

.pager {
	display: flex;
	justify-content: space-between;
	align-items: center;
	margin-top: 8px;
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

.gift {
	margin-left: 4px;
}

.gift.claimed {
	opacity: 0.4;
}

.item.unread .title::before {
	content: '● ';
	color: var(--accent);
}
</style>
