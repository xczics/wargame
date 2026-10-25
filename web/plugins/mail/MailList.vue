<script setup lang="ts">
import { formatTime } from '../../core/format';
import { computed, onBeforeUnmount, watch } from 'vue';
import type { MailInbox } from '../../../src/shared/api';
import { useGame } from '../../core/game';
import { page, pageKey, pages, readNow, selected } from './state';

const game = useGame('mail');
const inbox = computed(() => game.view('mail.inbox'));
const cursor = computed(() => (page.value > 0 ? pages.value[page.value - 1] : undefined));
// The older page shown: asked for with the syncs while it is.
let stop: (() => void) | null = null;
watch(
	cursor,
	(c) => {
		stop?.();
		stop = c ? game.instance(pageKey(c), 'mail.inbox', { mailBefore: String(c.before), mailBeforeId: c.beforeId }) : null;
	},
	{ immediate: true },
);
onBeforeUnmount(() => stop?.());
const current = computed(() => (cursor.value ? game.instanceData<MailInbox>(pageKey(cursor.value)) : inbox.value));
const loading = computed(() => !!cursor.value && !current.value);
const messages = computed(() => current.value?.messages ?? []);
// Read or not: from `mail.unread` (reading a mail changes that small view, not the inbox). Its ids are the newest
// unread ones; with more unread than it lists, a header it does not name says what it was listed with.
const unread = computed(() => game.view('mail.unread'));
const isRead = (m: { id: string; read: boolean }) => {
	const u = unread.value;
	if (!u) return m.read || readNow.value.has(m.id);
	if (u.ids.includes(m.id)) return false;
	if (readNow.value.has(m.id)) return true;
	return u.unread <= u.ids.length ? true : m.read;
};
// New mail shifts every older page: fetch them again when needed.
watch(
	() => inbox.value?.messages[0]?.id,
	() => {
		pages.value = [];
		page.value = 0;
	},
);

function older() {
	const last = messages.value[messages.value.length - 1];
	if (!last || loading.value) return;
	// The page's headers only (what the messages say comes when one is opened).
	const c = pages.value[page.value];
	if (!c || c.beforeId !== last.id) pages.value = [...pages.value.slice(0, page.value), { before: last.at, beforeId: last.id }];
	page.value++;
}

async function open(id: string, read: boolean) {
	// What it says comes meanwhile (the open message's view fetches it).
	selected.value = id;
	if (read) return;
	if (await game.command('mail.read', { ids: [id] })) readNow.value = new Set(readNow.value).add(id);
}
</script>

<template>
	<section class="card">
		<div class="head">
			<h2>{{ game.t('Mailbox') }}</h2>
			<button v-if="unread?.unread" type="button" class="small secondary" @click="game.command('mail.read', { all: true })">
				{{ game.t('Mark all read') }}
			</button>
		</div>
		<p v-if="!messages.length" class="muted">{{ game.t('No mail.') }}</p>
		<ul class="list">
			<li v-for="m in messages" :key="m.id">
				<button type="button" class="item" :class="{ active: m.id === selected, unread: !isRead(m) }" @click="open(m.id, isRead(m))">
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
